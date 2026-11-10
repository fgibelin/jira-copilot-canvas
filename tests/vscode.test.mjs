import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { AtlassianError, createAtlassian } from "../jira-copilot-canvas/atlassian.mjs";
import { startServer } from "../jira-copilot-canvas/server.mjs";
import { createWorkbench } from "../jira-copilot-canvas/workbench.mjs";
import { createVsCodeLauncher } from "../vscode/launcher.mjs";
import { registerTools, toolContributions } from "../vscode/tools.mjs";
import { createVsCodeTransport, normalizeToolResult, parseToolName } from "../vscode/transport.mjs";
import { relayRequest, renderWebview } from "../vscode/webview.mjs";
import { createMockAtlassian } from "./harness/mock-atlassian.mjs";
import { createRenderer } from "./harness/renderer.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "jira-copilot-canvas", "public");
const MIB = 1024 * 1024;
const UUID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const TOKEN = "f".repeat(32);

const cleanups = [];
after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
});

const request = (overrides) => ({ id: UUID, method: "GET", path: "/api/state", ...overrides });

/** A server that records what it receives and answers with whatever `handler` returns. */
async function listen(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
            seen.push(entry);
            const { status = 200, payload = { ok: true, data: { echoed: entry.url } }, raw } = handler?.(entry) ?? {};
            res.writeHead(status, { "content-type": raw === undefined ? "application/json" : "text/html" });
            res.end(raw ?? JSON.stringify(payload));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    return { seen, server: { url: `http://127.0.0.1:${server.address().port}/?k=${TOKEN}`, token: TOKEN } };
}

/** The commands and the clipboard of an editor, recorded; `failing` maps a command to true (it always fails) or to a function of its arguments. */
function fakeEditor({ failing = {} } = {}) {
    const executed = [];
    const clipboard = [];
    const vscode = {
        commands: {
            executeCommand: (command, ...args) => {
                executed.push([command, ...args]);
                const fails = failing[command];
                if (typeof fails === "function" ? fails(...args) : fails) return Promise.reject(new Error(`${command} is not available`));
                return undefined;
            },
        },
        env: {
            clipboard: {
                writeText: async (text) => {
                    clipboard.push(text);
                },
            },
        },
    };
    return { vscode, executed, clipboard };
}

/** The real canvas server over a workbench that reads from the in-memory Atlassian; without a `launcher`, one that records what it is asked to start. */
async function canvas({ launcher } = {}) {
    const mock = createMockAtlassian();
    const launches = [];
    launcher ??= {
        targets: async () => [{ id: "chat", kind: "chat", label: "New chat in VS Code", detail: "" }],
        launch: async (launch) => {
            launches.push(launch);
            return { sessionId: "", navigated: true, target: "chat", delivery: "prefilled" };
        },
    };
    const workbench = createWorkbench({ instanceId: "vscode-jira", atlassian: createAtlassian({ transport: mock.transport }), launcher, host: "VS Code" });
    const server = await startServer({ publicDir: PUBLIC_DIR, workbench });
    cleanups.push(async () => {
        await server.close();
        workbench.close();
    });
    return { server, workbench, mock, launches };
}

describe("the page of the webview", () => {
    const webview = {
        cspSource: "https://webview.test",
        asWebviewUri: (uri) => ({ toString: () => `https://webview.test/${path.relative(ROOT, uri.fsPath).split(path.sep).join("/")}` }),
    };
    const uriFile = (fsPath) => ({ fsPath });
    const render = () => renderWebview(webview, ROOT, uriFile);

    const policyOf = (html) => {
        const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
        assert.ok(content, "the page has a Content-Security-Policy");
        return Object.fromEntries(
            content
                .split(";")
                .map((directive) => directive.trim())
                .filter(Boolean)
                .map((directive) => {
                    const [name, ...sources] = directive.split(/\s+/);
                    return [name, sources];
                }),
        );
    };

    it("starts the head with a policy that lets scripts reach nothing but the files of the extension", async () => {
        const html = await render();
        assert.match(html, /<head>\s*<meta http-equiv="Content-Security-Policy"/);
        const policy = policyOf(html);
        assert.deepEqual(policy["default-src"], ["'none'"]);
        assert.deepEqual(policy["script-src"], [webview.cspSource]);
        assert.deepEqual(policy["connect-src"], ["'none'"]);
        assert.deepEqual(policy["base-uri"], ["'none'"]);
        assert.deepEqual(policy["form-action"], ["'none'"]);
        assert.ok(policy["style-src"].includes(webview.cspSource));
        assert.deepEqual(policy["img-src"], ["https:", "data:"]);
        assert.ok(!Object.values(policy).flat().some((source) => /unsafe-eval|\*/.test(source)));
        assert.ok(!policy["script-src"].includes("'unsafe-inline'"));
    });

    it("loads the stylesheet, the script and the theme from the webview, and nothing from the loopback server", async () => {
        const html = await render();
        assert.ok(!html.includes('href="/app.css"') && !html.includes('src="/js/app.js"'));
        assert.deepEqual(
            [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]),
            ["https://webview.test/jira-copilot-canvas/public/app.css", "https://webview.test/vscode/theme.css"],
            "the theme comes after the stylesheet, so that it can override it",
        );
        assert.match(html, /<script type="module" src="https:\/\/webview\.test\/jira-copilot-canvas\/public\/js\/app\.js"><\/script>/);
        assert.doesNotMatch(html, /127\.0\.0\.1|localhost|\?k=/);
    });

    it("has no script of its own, which the policy would refuse to run", async () => {
        const html = (await render()).replace(/<\/?script\b/gi, (tag) => tag.toUpperCase());
        const tags = html.match(/<script\b[^>]*>/gi) ?? [];
        assert.ok(tags.length > 0);
        for (const tag of tags) assert.match(tag, /\ssrc="/, tag);
    });

    it("escapes the addresses it writes into the page", async () => {
        const hostile = { cspSource: "https://webview.test", asWebviewUri: () => ({ toString: () => 'https://x.test/a"b&c<d>.css' }) };
        const html = await renderWebview(hostile, ROOT, uriFile);
        assert.ok(html.includes("a&quot;b&amp;c&lt;d&gt;.css"));
        assert.ok(!html.includes('a"b'));
    });

    it("fails when the page is not where it should be", async () => {
        await assert.rejects(renderWebview(webview, path.join(os.tmpdir(), "jira-canvas-no-such-root"), uriFile), { code: "ENOENT" });
    });
});

describe("the relay between the webview and the canvas server", () => {
    it("sends a request to the server with its token in a header, and not in the address", async () => {
        const { seen, server } = await listen();
        const query = { status: ["todo", "done"], q: "login bug", empty: "", none: undefined, nil: null, n: 5 };
        const answer = await relayRequest(request({ path: "/api/spaces/KAN/issues", query }), server);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, "GET");
        assert.equal(seen[0].url, "/api/spaces/KAN/issues?status=todo&status=done&q=login+bug&n=5");
        assert.equal(seen[0].headers["x-canvas-token"], TOKEN);
        assert.equal(seen[0].headers["content-type"], "application/json");
        assert.deepEqual(answer, { status: 200, payload: { ok: true, data: { echoed: seen[0].url } } });
    });

    it("sends a body with a POST or a PUT, and never with a GET", async () => {
        const { seen, server } = await listen();
        await relayRequest(request({ method: "POST", path: "/api/issues/KAN-2/session", body: { target: "chat", intent: "plan" } }), server);
        await relayRequest(request({ method: "PUT", path: "/api/view", body: { tab: "board" } }), server);
        await relayRequest(request({ method: "POST", path: "/api/refresh" }), server);
        await relayRequest(request({ method: "GET", path: "/api/state", body: { ignored: true } }), server);
        assert.deepEqual(
            seen.map((entry) => [entry.method, entry.url, entry.body]),
            [
                ["POST", "/api/issues/KAN-2/session", JSON.stringify({ target: "chat", intent: "plan" })],
                ["PUT", "/api/view", JSON.stringify({ tab: "board" })],
                ["POST", "/api/refresh", ""],
                ["GET", "/api/state", ""],
            ],
        );
    });

    it("hands back the status and the payload of the server, whatever they are", async () => {
        const failure = { ok: false, error: { code: "not_found", message: "No such work item." } };
        const { server } = await listen(() => ({ status: 404, payload: failure }));
        assert.deepEqual(await relayRequest(request({ path: "/api/issues/KAN-999" }), server), { status: 404, payload: failure });
    });

    it("rejects when the server does not answer with JSON, for the extension to report", async () => {
        const { server } = await listen(() => ({ status: 502, raw: "<h1>Bad gateway</h1>" }));
        await assert.rejects(relayRequest(request(), server), SyntaxError);
    });

    const refused = [
        ["a missing message", undefined],
        ["a message that is not an object", "GET /api/state"],
        ["an id that is not a UUID", request({ id: "1" })],
        ["a numeric id", request({ id: 1 })],
        ["no id", request({ id: undefined })],
        ["a method that is not allowed", request({ method: "DELETE" })],
        ["a method in lower case", request({ method: "get" })],
        ["a method that the path does not accept", request({ method: "POST", path: "/api/state" })],
        ["an absolute URL", request({ path: "https://evil.example/api/state" })],
        ["a protocol-relative URL", request({ path: "//evil.example/api/state" })],
        ["the page", request({ path: "/" })],
        ["a static asset", request({ path: "/js/app.js" })],
        ["the event stream", request({ path: "/events" })],
        ["a path that is not a string", request({ path: ["/api/state"] })],
        ["a route that does not exist", request({ path: "/api/nope" })],
        ["a query string inside the path", request({ path: "/api/state?x=1" })],
        ["a fragment", request({ path: "/api/state#x" })],
        ["a backslash", request({ path: "/api\\state" })],
        ["a dot segment", request({ path: "/api/spaces/./summary" })],
        ["a parent segment", request({ path: "/api/spaces/../boards" })],
        ["an encoded dot segment", request({ path: "/api/spaces/%2e%2e/boards" })],
        ["an encoded dot segment in capitals", request({ path: "/api/issues/%2E%2E" })],
        ["a half-encoded parent segment", request({ path: "/api/issues/.%2e" })],
    ];
    for (const [name, message] of refused) {
        it(`refuses ${name}, and sends nothing`, async () => {
            const { seen, server } = await listen();
            await assert.rejects(relayRequest(message, server), { message: "Invalid canvas request" });
            assert.deepEqual(seen, []);
        });
    }

    it("accepts the key of a work item that merely contains dots in its neighbours", async () => {
        const { seen, server } = await listen();
        await relayRequest(request({ path: "/api/issues/KAN-2/comments" }), server);
        await relayRequest(request({ path: "/api/confluence/pages/12345" }), server);
        assert.deepEqual(
            seen.map((entry) => entry.url),
            ["/api/issues/KAN-2/comments", "/api/confluence/pages/12345"],
        );
    });

    it("refuses a request over 1 MiB, and takes one that is exactly 1 MiB", async () => {
        const { seen, server } = await listen();
        const withNotes = (notes) => request({ method: "POST", path: "/api/issues/KAN-2/session", body: { notes } });
        const room = MIB - JSON.stringify(withNotes("")).length;
        assert.ok(room > 0);
        await assert.rejects(relayRequest(withNotes("x".repeat(room + 1)), server), { message: "Canvas request exceeds 1 MiB" });
        assert.deepEqual(seen, []);
        assert.equal((await relayRequest(withNotes("x".repeat(room)), server)).status, 200);
        assert.equal(seen.length, 1);
    });

    it("answers a request of the canvas API through the real server of a panel", async (t) => {
        const { server, launches } = await canvas();
        const call = async (message) => (await relayRequest(request(message), server)).payload;

        const state = await call({ path: "/api/state" });
        assert.equal(state.ok, true);
        assert.equal(state.data.instanceId, "vscode-jira");
        assert.equal(state.data.host, "VS Code");
        assert.equal(state.data.capabilities.openSession, true);

        assert.deepEqual(
            (await call({ path: "/api/spaces" })).data.spaces.map((space) => space.key),
            ["KAN", "SAM1"],
        );

        const page = await call({ path: "/api/spaces/KAN/issues", query: { limit: 2 } });
        assert.equal(page.data.items.length, 2, "the query reaches the server");

        assert.equal((await call({ method: "PUT", path: "/api/view", body: { tab: "board" } })).data.tab, "board");
        assert.equal((await call({ path: "/api/state" })).data.view.tab, "board");

        const started = await call({ method: "POST", path: "/api/issues/KAN-2/session", body: { target: "chat", intent: "plan", notes: "Start with the tests." } });
        assert.equal(started.ok, true);
        assert.deepEqual(started.data, { sessionId: "", navigated: true, target: "chat", delivery: "prefilled", name: "KAN-2: Task 2", key: "KAN-2", intent: "plan" });
        assert.equal(launches.length, 1);
        assert.equal(launches[0].target, "chat");
        assert.equal(launches[0].name, "KAN-2: Task 2");
        assert.match(launches[0].prompt, /Jira work item KAN-2/);
        assert.match(launches[0].prompt, /Notes from me:\nStart with the tests\./);
        t.diagnostic("the VS Code launcher receives the prompt that the Copilot app would have received");
    });

    it("hands back the status and the error of the canvas API when it refuses", async () => {
        const { vscode, executed } = fakeEditor();
        const { server } = await canvas({ launcher: createVsCodeLauncher(vscode, { log() {} }) });
        const missing = await relayRequest(request({ path: "/api/issues/KAN-999" }), server);
        assert.equal(missing.status, 404);
        assert.equal(missing.payload.ok, false);
        assert.equal(missing.payload.error.code, "not_found");
        const unknown = await relayRequest(request({ method: "POST", path: "/api/issues/KAN-2/session", body: { target: "same" } }), server);
        assert.equal(unknown.status, 400);
        assert.equal(unknown.payload.error.code, "invalid");
        assert.match(unknown.payload.error.message, /where the session should start/);
        assert.deepEqual(executed, [], "the editor was left alone");
    });

    it("fills the chat of the editor with a work item, from the button of the canvas to the draft of the prompt", async () => {
        const { vscode, executed, clipboard } = fakeEditor();
        const { server } = await canvas({ launcher: createVsCodeLauncher(vscode, { log() {} }) });
        const targets = await relayRequest(request({ path: "/api/targets" }), server);
        assert.deepEqual(targets.payload.data.targets.map((target) => target.id), ["chat"]);

        const started = await relayRequest(request({ method: "POST", path: "/api/issues/KAN-2/session", body: { target: "chat", intent: "implement" } }), server);
        assert.equal(started.status, 200);
        assert.equal(started.payload.data.delivery, "prefilled");
        assert.equal(started.payload.data.name, "KAN-2: Task 2");
        assert.deepEqual(
            executed.map(([command]) => command),
            ["workbench.action.chat.newChat", "workbench.action.chat.open"],
        );
        const [, options] = executed[1];
        assert.equal(options.isPartialQuery, true, "the prompt waits for the person to press Enter");
        assert.match(options.query, /Jira work item KAN-2/);
        assert.deepEqual(clipboard, []);
    });

    it("gives up on the server before the renderer gives up on the extension", async (t) => {
        const { bridge, timers } = renderer();
        bridge.request("GET", "/api/state").catch(() => {});
        const [{ ms: bridgeTimeout }] = timers.values();
        const waits = [];
        t.mock.method(AbortSignal, "timeout", (ms) => {
            waits.push(ms);
            return new AbortController().signal;
        });
        const { server } = await listen();
        await relayRequest(request(), server);
        assert.equal(waits.length, 1);
        assert.ok(waits[0] < bridgeTimeout, `${waits[0]} ms must be shorter than ${bridgeTimeout} ms`);
    });
});

/** The bridge of the renderer, with a record of what the page posted to the extension. */
function renderer(options) {
    const posted = [];
    return { ...createRenderer({ ...options, onPost: (message) => posted.push(message) }), posted };
}

describe("the bridge of the renderer", () => {
    const CHANNEL = "jira-canvas";

    it("does not exist outside VS Code, where the page talks plain HTTP", () => {
        assert.equal(renderer({ inVsCode: false }).bridge, null);
    });

    it("asks the extension through postMessage and settles with what it answers", async () => {
        const { bridge, posted, deliver } = renderer();
        const pending = bridge.request("GET", "/api/spaces", { site: "acme" });
        assert.equal(posted.length, 1);
        assert.deepEqual(posted[0], { channel: CHANNEL, type: "request", id: "00000000-0000-4000-8000-000000000001", method: "GET", path: "/api/spaces", query: { site: "acme" } });
        const answer = { channel: CHANNEL, id: posted[0].id, status: 200, payload: { ok: true, data: {} } };
        deliver(answer);
        assert.deepEqual(await pending, answer);
    });

    it("sends the body of a request along", () => {
        const { bridge, posted } = renderer();
        bridge.request("POST", "/api/issues/KAN-2/session", undefined, { target: "chat" }).catch(() => {});
        assert.deepEqual(posted[0].body, { target: "chat" });
    });

    it("keeps requests that are in flight together apart", async () => {
        const { bridge, posted, deliver } = renderer();
        const first = bridge.request("GET", "/api/spaces");
        const second = bridge.request("GET", "/api/boards");
        deliver({ channel: CHANNEL, id: posted[1].id, status: 200, payload: "second" });
        deliver({ channel: CHANNEL, id: posted[0].id, status: 200, payload: "first" });
        assert.equal((await first).payload, "first");
        assert.equal((await second).payload, "second");
    });

    it("ignores what is not an answer to one of its requests", async () => {
        const { bridge, posted, timers, deliver } = renderer();
        const pending = bridge.request("GET", "/api/spaces");
        let settled = false;
        pending.then(() => (settled = true), () => (settled = true));
        deliver(undefined);
        deliver({ channel: "somebody-else", id: posted[0].id, status: 200 });
        deliver({ channel: CHANNEL, id: "unknown", status: 200 });
        deliver({ channel: CHANNEL, type: "event", event: "view", data: {} });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(timers.size, 1);
        deliver({ channel: CHANNEL, id: posted[0].id, status: 200, payload: null });
        await pending;
    });

    it("stops waiting for a request once it is answered", async () => {
        const { bridge, posted, timers, deliver } = renderer();
        const pending = bridge.request("GET", "/api/spaces");
        assert.equal(timers.size, 1);
        deliver({ channel: CHANNEL, id: posted[0].id, status: 200, payload: null });
        await pending;
        assert.equal(timers.size, 0);
    });

    it("gives up after three minutes when the extension does not answer, and ignores a late answer", async () => {
        const { bridge, posted, timers, cleared, deliver } = renderer();
        const pending = bridge.request("GET", "/api/spaces");
        const [{ ms, fire }] = timers.values();
        assert.equal(ms, 180_000);
        fire();
        await assert.rejects(pending, { message: "The extension did not respond. Refresh and try again." });
        deliver({ channel: CHANNEL, id: posted[0].id, status: 200, payload: null });
        assert.deepEqual(cleared, [], "a late answer finds nothing waiting for it");
    });

    it("subscribes to the events of the extension, reports when they flow and relays them until it is closed", () => {
        const { bridge, posted, deliver } = renderer();
        const statuses = [];
        const events = [];
        const close = bridge.connect((event, data) => events.push([event, data]), (status) => statuses.push(status));
        assert.deepEqual(statuses, ["connecting"]);
        assert.deepEqual(posted, [{ channel: CHANNEL, type: "subscribe" }]);

        deliver({ channel: CHANNEL, type: "event", event: "hello", data: { instanceId: "vscode-jira" } });
        deliver({ channel: CHANNEL, type: "event", event: "view", data: { view: { tab: "board" } } });
        assert.deepEqual(statuses, ["connecting", "live"]);
        assert.deepEqual(events, [
            ["hello", { instanceId: "vscode-jira" }],
            ["view", { view: { tab: "board" } }],
        ]);

        close();
        assert.deepEqual(statuses, ["connecting", "live", "closed"]);
        deliver({ channel: CHANNEL, type: "event", event: "view", data: {} });
        assert.equal(events.length, 2);
    });
});

describe("the Atlassian tools of VS Code", () => {
    const parsed = (name) => parseToolName(name);

    it("splits the name of an MCP tool into its server and its tool, at the last underscore", () => {
        assert.deepEqual(parsed("mcp_atlassian_getJiraIssue"), { server: "atlassian", name: "getJiraIssue" });
        assert.deepEqual(parsed("mcp_Atlassian-MCP-Server_executeRead"), { server: "Atlassian-MCP-Server", name: "executeRead" });
        assert.deepEqual(parsed("mcp_my_atlassian_searchJiraIssuesUsingJql"), { server: "my_atlassian", name: "searchJiraIssuesUsingJql" });
        assert.deepEqual(parsed("atlassian_getJiraIssue"), { server: "atlassian", name: "getJiraIssue" }, "the prefix is optional");
    });

    it("recognises no tool in a name that has no server, no tool, or a tool that does not start with a letter", () => {
        for (const name of ["getJiraIssue", "", "mcp_atlassian_", "mcp_atlassian_9lives", undefined, null, 42, {}]) assert.equal(parsed(name), null, String(name));
    });

    it("takes the compact block of a result as its text and the next block as its richer data", () => {
        assert.deepEqual(normalizeToolResult({ content: [{ value: '{"data":1}' }, { value: '{"raw":1}' }] }), { ok: true, text: '{"data":1}', structured: '{"raw":1}' });
        assert.deepEqual(normalizeToolResult({ content: [{ value: "only text" }] }), { ok: true, text: "only text", structured: null });
    });

    it("prefers a JSON data part over a second text part for the richer data", () => {
        const data = new TextEncoder().encode('{"raw":2}');
        const result = normalizeToolResult({ content: [{ value: "text" }, { value: "second" }, { data, mimeType: "application/json" }] });
        assert.deepEqual(result, { ok: true, text: "text", structured: '{"raw":2}' });
    });

    it("ignores a data part that is not JSON, and the parts that are not text", () => {
        const image = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
        assert.deepEqual(normalizeToolResult({ content: [image, { value: { tsx: true } }, { value: "text" }] }), { ok: true, text: "text", structured: null });
    });

    it("reads an empty or malformed result as empty", () => {
        for (const result of [undefined, null, {}, { content: "nope" }, { content: [] }]) assert.deepEqual(normalizeToolResult(result), { ok: true, text: "", structured: null });
    });

    /** What `vscode.lm` offers, with the Atlassian tools of the mock and the other tools a window has. */
    function editorOver(mock, { invoke } = {}) {
        const calls = [];
        const sources = [];
        const names = new Map(mock.toolList().map((tool) => [`mcp_atlassian_${tool.name}`, tool.id]));
        const vscode = {
            lm: {
                tools: [...names.keys(), "copilot_readFile", "jira_canvas_get_view", "plainname", "mcp_github_listIssues"].map((name) => ({ name })),
                invokeTool: async (name, options, token) => {
                    calls.push({ name, options, token });
                    if (invoke) return invoke(name, options, token);
                    const result = await mock.transport.invoke(names.get(name), options.input);
                    if (!result.ok) throw new Error(result.error ?? result.text);
                    return { content: [{ value: result.text }, ...(result.structured ? [{ value: JSON.stringify(result.structured) }] : [])] };
                },
            },
            CancellationTokenSource: class {
                constructor() {
                    this.token = { isCancellationRequested: false };
                    sources.push(this);
                }
                dispose() {
                    this.disposed = true;
                }
            },
        };
        return { vscode, calls, sources };
    }

    it("lists the tools of the window that have a server and a tool name, and not its own", async () => {
        const { vscode } = editorOver(createMockAtlassian());
        const tools = await createVsCodeTransport(vscode).tools();
        const byId = new Map(tools.map((tool) => [tool.id, tool]));
        assert.deepEqual(byId.get("mcp_atlassian_getJiraIssue"), { id: "mcp_atlassian_getJiraIssue", server: "atlassian", name: "getJiraIssue" });
        assert.deepEqual(byId.get("copilot_readFile"), { id: "copilot_readFile", server: "copilot", name: "readFile" });
        assert.deepEqual(byId.get("mcp_github_listIssues"), { id: "mcp_github_listIssues", server: "github", name: "listIssues" });
        assert.ok(!byId.has("jira_canvas_get_view"), "the tools of this extension are not Atlassian tools");
        assert.ok(!byId.has("plainname"));
    });

    it("lists nothing when the window has no language model tools", async () => {
        assert.deepEqual(await createVsCodeTransport({}).tools(), []);
        assert.deepEqual(await createVsCodeTransport({ lm: {} }).tools(), []);
        assert.deepEqual(await createVsCodeTransport({ lm: { tools: [] } }).tools(), []);
    });

    it("invokes a tool outside of any chat, with a token it disposes of afterwards", async () => {
        const { vscode, calls, sources } = editorOver(createMockAtlassian());
        const result = await createVsCodeTransport(vscode).invoke("mcp_atlassian_getJiraIssue", { cloudId: "c", issueIdOrKey: "KAN-2" });
        assert.equal(result.ok, true);
        assert.equal(JSON.parse(result.text).data !== undefined || result.text.length > 0, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].options, { input: { cloudId: "c", issueIdOrKey: "KAN-2" }, toolInvocationToken: undefined });
        assert.equal(calls[0].token, sources[0].token);
        assert.equal(sources.length, 1);
        assert.equal(sources[0].disposed, true);
    });

    it("turns a tool that throws into a failed result, and still disposes of the token", async () => {
        const failing = editorOver(createMockAtlassian(), {
            invoke: async () => {
                throw new Error("MCP server 'atlassian': 401 Unauthorized");
            },
        });
        assert.deepEqual(await createVsCodeTransport(failing.vscode).invoke("mcp_atlassian_getJiraIssue", {}), {
            ok: false,
            text: "MCP server 'atlassian': 401 Unauthorized",
            structured: null,
            error: "MCP server 'atlassian': 401 Unauthorized",
        });
        assert.equal(failing.sources[0].disposed, true);

        const odd = editorOver(createMockAtlassian(), { invoke: () => Promise.reject("plain string") });
        assert.equal((await createVsCodeTransport(odd.vscode).invoke("x_y", {})).error, "plain string");
    });

    it("lets the data layer read Jira through the tools of the window, and only read", async () => {
        const mock = createMockAtlassian();
        const { vscode } = editorOver(mock);
        const workbench = createWorkbench({ instanceId: "vscode-jira", atlassian: createAtlassian({ transport: createVsCodeTransport(vscode) }), host: "VS Code" });
        const { spaces } = await workbench.spaces({});
        assert.deepEqual(spaces.map((space) => space.key), ["KAN", "SAM1"]);
        const issue = await workbench.issue({ key: "KAN-2" });
        assert.equal(issue.summary, "Task 2");
        assert.ok(mock.calls.length > 0);
        for (const tool of mock.calledTools()) assert.ok(!/^(?:create|edit|transition|addOrEdit|update|executeWrite|executeDestructive)/.test(tool), `${tool} writes`);
    });

    it("reports that the Atlassian MCP server is not available when the window has none of its tools", async () => {
        const workbench = createWorkbench({ instanceId: "vscode-jira", atlassian: createAtlassian({ transport: createVsCodeTransport({ lm: { tools: [{ name: "copilot_readFile" }, { name: "jira_canvas_get_view" }] } }) }), host: "VS Code" });
        await assert.rejects(workbench.spaces({}), { code: "not_connected", message: /Atlassian MCP server is not available.*https:\/\/mcp\.atlassian\.com\/v1\/mcp/ });
    });
});

describe("starting a chat from a work item in VS Code", () => {
    const PROMPT = "I opened this session from the Jira work item KAN-2.\n\nInvestigate this work item.";

    function editor(options) {
        const logged = [];
        const { vscode, executed, clipboard } = fakeEditor(options);
        return { launcher: createVsCodeLauncher(vscode, { log: (level, message) => logged.push([level, message]) }), executed, clipboard, logged };
    }

    it("offers one place to start: a new chat of the editor", async () => {
        const { launcher } = editor();
        const targets = await launcher.targets();
        assert.equal(targets.length, 1);
        assert.deepEqual({ id: targets[0].id, kind: targets[0].kind, label: targets[0].label }, { id: "chat", kind: "chat", label: "New chat in VS Code" });
        assert.match(targets[0].detail, /nothing is sent until you press Enter/i);
        targets[0].label = "changed";
        assert.equal((await launcher.targets())[0].label, "New chat in VS Code", "every call gets its own copy");
    });

    it("opens a new chat with the prompt typed in, as a draft that waits for the person to send it", async () => {
        const { launcher, executed, clipboard } = editor();
        const started = await launcher.launch({ target: "chat", name: "KAN-2: Task 2", prompt: PROMPT, mode: "plan" });
        assert.deepEqual(executed, [["workbench.action.chat.newChat"], ["workbench.action.chat.open", { query: PROMPT, isPartialQuery: true, mode: "agent" }]]);
        assert.equal(started.delivery, "prefilled");
        assert.deepEqual({ sessionId: started.sessionId, navigated: started.navigated, target: started.target }, { sessionId: "", navigated: true, target: "chat" });
        assert.match(started.message, /Copilot Chat is open with “KAN-2: Task 2”\. Review the prompt, then press Enter to send it\./);
        assert.deepEqual(clipboard, []);
    });

    it("never sends the prompt, whatever the editor does", async () => {
        for (const failing of [{}, { "workbench.action.chat.newChat": true }, { "workbench.action.chat.open": true }]) {
            const { launcher, executed } = editor({ failing });
            await launcher.launch({ target: "chat", name: "KAN-2", prompt: PROMPT });
            for (const [command, options] of executed) {
                assert.doesNotMatch(command, /submit|accept|send|run|autopilot/i, command);
                assert.notEqual(options?.isPartialQuery, false, "the query is always a draft");
            }
        }
    });

    it("tries again without the agent mode when this version of the editor does not know it", async () => {
        const { launcher, executed, clipboard } = editor({ failing: { "workbench.action.chat.open": (options) => options?.mode === "agent" } });
        const started = await launcher.launch({ target: "chat", name: "KAN-2", prompt: PROMPT });
        assert.equal(started.delivery, "prefilled");
        assert.deepEqual(executed.slice(1), [
            ["workbench.action.chat.open", { query: PROMPT, isPartialQuery: true, mode: "agent" }],
            ["workbench.action.chat.open", { query: PROMPT, isPartialQuery: true }],
        ]);
        assert.deepEqual(clipboard, []);
    });

    it("puts the prompt on the clipboard when the editor cannot fill the chat in", async () => {
        const { launcher, executed, clipboard, logged } = editor({ failing: { "workbench.action.chat.open": (options) => options !== undefined } });
        const started = await launcher.launch({ target: "chat", name: "KAN-2: Task 2", prompt: PROMPT });
        assert.equal(started.delivery, "clipboard");
        assert.deepEqual(clipboard, [PROMPT]);
        assert.deepEqual(executed.at(-1), ["workbench.action.chat.open"], "it still brings the chat forward");
        assert.match(started.message, /The prompt for “KAN-2: Task 2” is on your clipboard\. Open Copilot Chat and paste it\./);
        assert.equal(logged.filter(([level, message]) => level === "warning" && /workbench\.action\.chat\.open failed/.test(message)).length, 2);
    });

    it("does not fail when even bringing the chat forward fails", async () => {
        const { launcher, clipboard } = editor({ failing: { "workbench.action.chat.open": true } });
        const started = await launcher.launch({ target: "chat", name: "KAN-2", prompt: PROMPT });
        assert.equal(started.delivery, "clipboard");
        assert.deepEqual(clipboard, [PROMPT]);
    });

    it("carries on when it cannot start a new chat, and says so in the log", async () => {
        const { launcher, executed, logged } = editor({ failing: { "workbench.action.chat.newChat": true } });
        const started = await launcher.launch({ target: "chat", name: "KAN-2", prompt: PROMPT });
        assert.equal(started.delivery, "prefilled");
        assert.equal(executed.length, 2);
        assert.deepEqual(logged, [["warning", "Could not start a new chat: workbench.action.chat.newChat is not available"]]);
    });

    it("refuses a place it does not know, before it touches the editor", async () => {
        for (const target of ["same", "project:proj-1", "Chat", "", undefined, null]) {
            const { launcher, executed, clipboard } = editor();
            await assert.rejects(launcher.launch({ target, name: "KAN-2", prompt: PROMPT }), (error) => error instanceof AtlassianError && error.code === "invalid" && /where the session should start/.test(error.message), String(target));
            assert.deepEqual(executed, []);
            assert.deepEqual(clipboard, []);
        }
    });
});

describe("the tools of Copilot Chat", () => {
    const ajv = () => new Ajv({ allErrors: true, strict: true, strictTypes: true, strictTuples: true, strictRequired: true });
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

    it("declares one tool for every action of the agent, in the manifest of the extension", () => {
        const tools = toolContributions();
        assert.equal(tools.length, 17);
        assert.deepEqual(manifest.contributes.languageModelTools, tools, "run npm run sync-tools");
        assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
        assert.equal(new Set(tools.map((tool) => tool.toolReferenceName)).size, tools.length);
    });

    it("names its tools the way the editor requires, and the way the tests expect", () => {
        for (const tool of toolContributions()) {
            assert.match(tool.name, /^jira_canvas_[a-z_]+$/);
            assert.match(tool.toolReferenceName, /^jira_[a-z_]+$/);
            assert.match(tool.displayName, /^Jira: [a-z ]+$/);
            assert.equal(tool.when, "isWorkspaceTrusted");
            assert.equal(tool.canBeReferencedInPrompt, true);
            assert.ok(tool.userDescription.length > 20 && tool.userDescription.length < tool.modelDescription.length);
            assert.match(tool.modelDescription, /open it first with "Jira: Open Jira Canvas"/);
        }
    });

    it("declares an input schema that is valid for each tool, and no tool that writes or starts a session", () => {
        const validator = ajv();
        for (const tool of toolContributions()) {
            assert.equal(tool.inputSchema.type, "object", tool.name);
            assert.doesNotThrow(() => validator.compile(tool.inputSchema), tool.name);
            assert.doesNotMatch(tool.name, /session|launch|start|create|write|edit|delete|transition/i);
        }
    });

    it("declares the command that opens the canvas, which the tools tell the model to run", () => {
        assert.deepEqual(manifest.contributes.commands, [{ command: "jiraCanvas.open", title: "Open Jira Canvas", category: "Jira" }]);
        assert.match(toolContributions()[0].modelDescription, new RegExp(`${manifest.contributes.commands[0].category}: ${manifest.contributes.commands[0].title}`));
    });

    /** What `registerTools` needs of the editor, with the tools it registers kept by name. */
    function chat({ trusted = true } = {}) {
        const registered = new Map();
        const vscode = {
            workspace: { isTrusted: trusted },
            lm: {
                registerTool: (name, implementation) => {
                    registered.set(name, implementation);
                    return { dispose: () => registered.delete(name) };
                },
            },
            CancellationError: class CancellationError extends Error {
                constructor() {
                    super("Canceled");
                    this.name = "Canceled";
                }
            },
            LanguageModelTextPart: class {
                constructor(value) {
                    this.value = value;
                }
            },
            LanguageModelToolResult: class {
                constructor(content) {
                    this.content = content;
                }
            },
        };
        return { vscode, registered, context: { subscriptions: [] } };
    }

    async function ready({ trusted } = {}) {
        const mock = createMockAtlassian();
        const workbench = createWorkbench({ instanceId: "vscode-jira", atlassian: createAtlassian({ transport: mock.transport }), host: "VS Code" });
        cleanups.push(() => workbench.close());
        const editor = chat({ trusted });
        const logged = [];
        registerTools(editor.vscode, editor.context, () => ({ workbench }), (level, message) => logged.push([level, message]));
        return { ...editor, mock, workbench, logged, invoke: (name, input, cancelled = false) => editor.registered.get(`jira_canvas_${name}`).invoke({ input }, { isCancellationRequested: cancelled }) };
    }

    it("registers the tools the manifest declares, and hands every registration to the editor to dispose of", async () => {
        const { registered, context } = await ready();
        assert.deepEqual([...registered.keys()].sort(), toolContributions().map((tool) => tool.name).sort());
        assert.equal(context.subscriptions.length, 17);
        for (const subscription of context.subscriptions) assert.equal(typeof subscription.dispose, "function");
    });

    it("says what a tool is about to do before it runs", async () => {
        const { registered } = await ready();
        assert.deepEqual(registered.get("jira_canvas_list_spaces").prepareInvocation(), { invocationMessage: "Jira: list spaces" });
        assert.deepEqual(registered.get("jira_canvas_get_issue").prepareInvocation(), { invocationMessage: "Jira: get issue" });
    });

    it("answers with the JSON of what the action returned, as one text part", async () => {
        const { invoke, vscode } = await ready();
        const result = await invoke("list_spaces", {});
        assert.ok(result instanceof vscode.LanguageModelToolResult);
        assert.equal(result.content.length, 1);
        assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
        assert.deepEqual(JSON.parse(result.content[0].value).spaces.map((space) => space.key), ["KAN", "SAM1"]);
    });

    it("passes the input of the model on to the action, and reads from the panel it belongs to", async () => {
        const { invoke, workbench } = await ready();
        const issue = JSON.parse((await invoke("get_issue", { key: "KAN-2" })).content[0].value);
        assert.equal(issue.key, "KAN-2");
        assert.equal(issue.summary, "Task 2");
        await invoke("set_view", { tab: "board", space: "KAN" });
        assert.equal(workbench.getView().tab, "board");
        assert.equal(JSON.parse((await invoke("get_view", {})).content[0].value).view.space, "KAN");
    });

    it("does nothing when the request is already cancelled", async () => {
        const { invoke, mock, vscode } = await ready();
        await assert.rejects(invoke("list_spaces", {}, true), vscode.CancellationError);
        assert.deepEqual(mock.calls, []);
    });

    it("does nothing in a workspace that is not trusted", async () => {
        const { invoke, mock } = await ready({ trusted: false });
        await assert.rejects(invoke("list_spaces", {}), { message: "Trust this workspace before using the Jira tools." });
        assert.deepEqual(mock.calls, []);
    });

    it("fails with an error the model can read when the action refuses", async () => {
        const { invoke, logged } = await ready();
        await assert.rejects(invoke("get_issue", { key: "KAN-999" }), (error) => error instanceof AtlassianError && error.code === "not_found");
        await assert.rejects(invoke("get_issue", { key: "nope" }), (error) => error instanceof AtlassianError && error.code === "invalid");
        await assert.rejects(invoke("set_view", { tab: "timeline" }), (error) => error instanceof AtlassianError && error.code === "invalid");
        assert.deepEqual(logged, [], "refusals are not unexpected errors");
    });
});
