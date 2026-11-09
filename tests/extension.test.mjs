// The Copilot extension as the app runs it: extension.mjs is loaded against a recording stand-in for the SDK (see
// tests/harness) and the Atlassian MCP server is the in-memory mock reached through `session.rpc.tools`.
import "./harness/register.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import Ajv from "ajv";
import { TABS } from "../jira-copilot-canvas/workbench.mjs";
import { ALLOWED_OPERATIONS, ALLOWED_TOOLS, createMockAtlassian } from "./harness/mock-atlassian.mjs";
import { CanvasError, captured } from "./harness/shim-sdk.mjs";

const CREATED = "7f2b9c1e-3d4a-4b5c-8d6e-0123456789ab";
const HOST_TOOLS = ["list_repositories", "create_session", "navigate_to"];

/** One valid call for every action: a new action cannot be added without being tried here. */
const EVERYTHING = {
    get_view: {},
    set_view: { space: "KAN", tab: "issues" },
    select_issue: { key: "KAN-2" },
    list_spaces: {},
    get_space: { space: "KAN" },
    list_boards: { space: "KAN" },
    get_board: { id: 1 },
    list_issues: { space: "KAN" },
    get_issue: { key: "KAN-2" },
    list_versions: { space: "KAN" },
    list_components: { space: "KAN" },
    list_confluence_spaces: {},
    list_confluence_pages: { space: "ENG" },
    get_confluence_page: { id: "20001" },
    search_confluence: { q: "runbook" },
    refresh: {},
    diagnose: {},
};

const ok = (text, structured) => ({ resultType: "success", contents: [{ type: "text", text }], ...(structured && { structuredContent: structured }) });
const failed = (message) => ({ resultType: "failure", contents: [], error: message });

// What the app itself answers when the extension manages sessions; everything else is Atlassian.
const defaultHost = () => ({
    list_repositories: () => ok(JSON.stringify([{ id: "proj-1", name: "jira-copilot-canvas", github_repo: "fgibelin/jira-copilot-canvas", main_repo_path: "/work/jira-copilot-canvas" }])),
    create_session: () => ok(JSON.stringify({ session_id: CREATED })),
    navigate_to: () => ok("Switched."),
});
let host = defaultHost();

const mock = createMockAtlassian();
captured.metadataHandler = () => mock.metadata();
captured.toolHandler = (request) => (Object.hasOwn(host, request.name) ? host[request.name](request.arguments) : mock.execute(request));

await import("../jira-copilot-canvas/extension.mjs");
const canvas = captured.config.canvases[0];
const startupLogs = [...captured.logs];

const temporary = [];
function tempDir({ git = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-canvas-ext-"));
    temporary.push(dir);
    if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
}
const repository = tempDir({ git: true });
after(() => {
    for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` with git unable to look above `dir`'s parent, so that a temporary folder is never taken for part of some other repository. */
async function outsideAnyRepository(dir, fn) {
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(fs.realpathSync(dir));
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = before;
    }
}

const opened = [];
let counter = 0;

const connect = (url) => {
    const { port, searchParams } = new URL(url);
    return { port: Number(port), token: searchParams.get("k") };
};

/** Opens a panel the way the app does and returns where to reach it. */
async function open(input, { id = `ext-${++counter}`, cwd = repository } = {}) {
    opened.push(id);
    const result = await canvas.open({ instanceId: id, session: { workingDirectory: cwd }, input });
    return { id, ...result, ...connect(result.url) };
}

/** Runs an action of the agent for an instance, the way the app does. */
function action(name, input = {}, instanceId = "ext-agent") {
    opened.push(instanceId);
    return canvas.actions.find((candidate) => candidate.name === name).handler({ instanceId, input });
}

/** The data layer is shared by every panel of the extension and caches what it reads: this starts a test from a clean one. */
async function forget() {
    await canvas.actions.find((candidate) => candidate.name === "refresh").handler({ instanceId: "ext-cache", input: {} });
    await canvas.onClose({ instanceId: "ext-cache" });
}

function raw({ port, token }, { method = "GET", target = "/", body, authenticated = true } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { ...(authenticated && { "x-canvas-token": token }), ...(body !== undefined && { "content-type": "application/json" }) };
        const request = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json;
                try {
                    json = JSON.parse(text);
                } catch {}
                resolve({ status: response.statusCode, headers: response.headers, text, json });
            });
        });
        request.on("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

const data = (response) => {
    assert.equal(response.status, 200, response.text.slice(0, 300));
    assert.equal(response.json.ok, true);
    return response.json.data;
};
const failure = (response, status, code, message) => {
    assert.equal(response.status, status, response.text.slice(0, 300));
    assert.equal(response.json?.ok, false);
    assert.equal(response.json.error.code, code);
    if (message !== undefined) assert.match(response.json.error.message, message);
};
const stateOf = async (panel) => data(await raw(panel, { target: "/api/state" }));
const isCanvasError = (code) => (error) => error instanceof CanvasError && error.code === code;

beforeEach(async () => {
    host = defaultHost();
    captured.toolCalls.length = 0;
    captured.metadataHandler = () => mock.metadata();
    mock.reset();
    await forget();
});

afterEach(async () => {
    for (const id of new Set(opened.splice(0))) await canvas.onClose({ instanceId: id });
});

describe("what the extension declares", () => {
    it("joins the session with a single canvas", () => {
        assert.deepEqual(Object.keys(captured.config), ["canvases"]);
        assert.equal(captured.config.canvases.length, 1);
        assert.equal(canvas.id, "jira-copilot-canvas");
        assert.equal(canvas.displayName, "Jira & Confluence");
        assert.match(canvas.description, /^[^\n]{40,250}$/);
    });

    it("says it is ready through the session log, which is where it reports", () => {
        assert.deepEqual(startupLogs, [{ message: "Jira canvas ready.", level: "info", ephemeral: true }]);
    });

    it("offers the read-only actions of the agent and none that starts a session", () => {
        const names = canvas.actions.map((candidate) => candidate.name);
        assert.deepEqual([...names].sort(), Object.keys(EVERYTHING).sort());
        assert.equal(new Set(names).size, names.length);
        for (const candidate of canvas.actions) {
            assert.ok(!candidate.name.startsWith("canvas."), `${candidate.name} is reserved by the host`);
            assert.equal(typeof candidate.handler, "function", candidate.name);
            assert.match(candidate.description, /\S/, candidate.name);
        }
        assert.deepEqual(names.filter((name) => /session|launch|start|create|write|edit|delete|transition/i.test(name)), []);
    });

    it("validates what the canvas is opened with", () => {
        const validate = new Ajv({ allErrors: true, strict: true, strictTypes: true, strictTuples: true, strictRequired: true }).compile(canvas.inputSchema);
        assert.deepEqual(canvas.inputSchema.properties.tab.enum, [...TABS]);
        for (const good of [{}, { space: "KAN" }, { site: "acme", space: "KAN", issue: "KAN-2", tab: "board" }]) assert.equal(validate(good), true, JSON.stringify(validate.errors));
        for (const bad of [{ tab: "timeline" }, { space: "K".repeat(41) }, { issue: 12 }, { site: "s".repeat(201) }, "KAN"]) assert.equal(validate(bad), false, JSON.stringify(bad));
    });
});

describe("opening the canvas", () => {
    it("serves a panel on loopback, behind a token", async () => {
        opened.push("ext-first");
        const result = await canvas.open({ instanceId: "ext-first", input: { space: "kan", tab: "board" } });
        assert.deepEqual(Object.keys(result), ["url", "title", "status"]);
        assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}$/);
        assert.equal(result.title, "Jira");
        assert.equal(result.status, "Jira · KAN");

        const panel = connect(result.url);
        const state = await stateOf(panel);
        assert.equal(state.instanceId, "ext-first");
        assert.equal(state.host, "Copilot");
        assert.equal(state.view.space, "KAN");
        assert.equal(state.view.tab, "board");
        assert.equal(state.capabilities.openSession, true);
        failure(await raw(panel, { target: "/api/state", authenticated: false }), 401, "unauthorized");

        const page = await raw(panel, { authenticated: false });
        assert.equal(page.status, 200);
        assert.match(page.headers["content-type"], /text\/html/);
        assert.match(page.text, /<title>Jira<\/title>/);
    });

    it("opens on the summary of the site when it is given nothing it can use", async () => {
        for (const input of [undefined, null, {}, "KAN", ["KAN"], 7, { color: "red", tab: "", space: "  " }]) {
            const panel = await open(input);
            assert.equal(panel.status, "Jira", JSON.stringify(input));
            const { view } = await stateOf(panel);
            assert.deepEqual([view.space, view.tab], ["", "summary"], JSON.stringify(input));
        }
    });

    it("works without the folder of the session", async () => {
        opened.push("ext-no-session");
        const { url } = await canvas.open({ instanceId: "ext-no-session", input: { space: "KAN" } });
        assert.equal((await raw(connect(url), { target: "/api/state" })).status, 200);
    });

    it("opens a work item from its key alone", async () => {
        const panel = await open({ issue: "kan-2" });
        assert.equal(panel.status, "Jira · KAN");
        const { view } = await stateOf(panel);
        assert.deepEqual([view.space, view.issue, view.tab], ["KAN", "KAN-2", "issues"]);
    });

    it("refuses an input that makes no sense, and starts nothing", async () => {
        for (const input of [{ space: "not a key!" }, { tab: "timeline" }, { issue: "KAN" }, { site: "s".repeat(201) }]) {
            await assert.rejects(canvas.open({ instanceId: "ext-bad", input }), isCanvasError("invalid"), JSON.stringify(input));
        }
        const panel = await open({ space: "SAM1" }, { id: "ext-bad" });
        assert.equal((await stateOf(panel)).view.space, "SAM1");
    });

    it("keeps a panel as it was when it is re-opened with an input that makes no sense", async () => {
        const panel = await open({ space: "KAN", tab: "board" });
        await assert.rejects(canvas.open({ instanceId: panel.id, input: { tab: "timeline" } }), isCanvasError("invalid"));
        const { view } = await stateOf(panel);
        assert.deepEqual([view.space, view.tab], ["KAN", "board"]);
    });
});

describe("several panels and repeated opens", () => {
    it("shares one server between opens that arrive together", async () => {
        const id = "ext-together";
        const results = await Promise.all([open({ space: "KAN" }, { id }), open({ space: "KAN" }, { id }), open({ space: "KAN" }, { id })]);
        assert.equal(new Set(results.map((result) => result.url)).size, 1);
        assert.equal((await raw(results[0], { target: "/api/state" })).status, 200);
    });

    it("re-opens a panel on the new input, at the same address", async () => {
        const first = await open({ space: "KAN", tab: "board" });
        const second = await open({ space: "SAM1", tab: "issues" }, { id: first.id });
        assert.equal(second.url, first.url);
        assert.equal(second.status, "Jira · SAM1");
        let { view } = await stateOf(first);
        assert.deepEqual([view.space, view.tab], ["SAM1", "issues"]);

        const third = await open({}, { id: first.id });
        assert.equal(third.url, first.url);
        assert.equal(third.status, "Jira · SAM1");
        ({ view } = await stateOf(first));
        assert.deepEqual([view.space, view.tab], ["SAM1", "issues"]);
    });

    it("gives every panel its own server, token and view", async () => {
        const [a, b] = await Promise.all([open({ space: "KAN" }), open({ space: "SAM1" })]);
        assert.notEqual(a.port, b.port);
        assert.notEqual(a.token, b.token);
        assert.equal((await stateOf(a)).view.space, "KAN");
        assert.equal((await stateOf(b)).view.space, "SAM1");
        failure(await raw({ port: b.port, token: a.token }, { target: "/api/state" }), 401, "unauthorized");
    });
});

describe("closing the canvas", () => {
    it("stops the server of the panel and only that one", async () => {
        const [closing, staying] = await Promise.all([open({ space: "KAN" }), open({ space: "SAM1" })]);
        await canvas.onClose({ instanceId: closing.id });
        await assert.rejects(raw(closing, { authenticated: false }), { code: "ECONNREFUSED" });
        assert.equal((await raw(staying, { authenticated: false })).status, 200);
    });

    it("is harmless for a panel that was never opened or is already closed", async () => {
        await canvas.onClose({ instanceId: "ext-never" });
        const panel = await open({});
        await canvas.onClose({ instanceId: panel.id });
        await canvas.onClose({ instanceId: panel.id });
        await Promise.all([canvas.onClose({ instanceId: panel.id }), canvas.onClose({ instanceId: panel.id })]);
        await assert.rejects(raw(panel, { authenticated: false }), { code: "ECONNREFUSED" });
    });

    it("leaves no server behind when it comes while the server is still starting", async () => {
        const id = "ext-racing";
        opened.push(id);
        const opening = canvas.open({ instanceId: id, input: { space: "KAN" } });
        await canvas.onClose({ instanceId: id });
        const { url } = await opening;
        await assert.rejects(raw(connect(url), { authenticated: false }), { code: "ECONNREFUSED" });
    });

    it("starts afresh when a closed panel is opened again", async () => {
        const first = await open({ space: "KAN" });
        await canvas.onClose({ instanceId: first.id });
        const second = await open({ space: "SAM1" }, { id: first.id });
        assert.notEqual(second.token, first.token);
        assert.equal((await stateOf(second)).view.space, "SAM1");
    });
});

describe("the actions of the agent", () => {
    it("run through the tools of the session and return what Atlassian says", async () => {
        const { site, spaces } = await action("list_spaces");
        assert.equal(site, "https://acme.atlassian.net");
        assert.deepEqual(spaces.map((space) => space.key), ["KAN", "SAM1"]);
        const known = new Set(mock.metadata().tools.map((tool) => tool.name));
        assert.ok(captured.toolCalls.length > 0);
        for (const call of captured.toolCalls) assert.ok(known.has(call.name), call.name);
    });

    it("only read from Atlassian and never touch the sessions of the app, whatever they are asked", async () => {
        for (const [name, input] of Object.entries(EVERYTHING)) await action(name, input);
        assert.ok(mock.calls.length >= 12);
        for (const tool of mock.calledTools()) assert.ok(ALLOWED_TOOLS.includes(tool), `tool ${tool}`);
        for (const operation of mock.calledOperations()) assert.ok(ALLOWED_OPERATIONS.includes(operation), `operation ${operation}`);
        assert.deepEqual(captured.toolCalls.filter((call) => HOST_TOOLS.includes(call.name)), []);
    });

    it("share the view with the panel of the same instance, and only with that one", async () => {
        const panel = await open({ space: "KAN" });
        assert.equal((await action("get_view", {}, panel.id)).view.space, "KAN");

        await action("set_view", { space: "SAM1", tab: "issues" }, panel.id);
        const { view } = await stateOf(panel);
        assert.deepEqual([view.space, view.tab], ["SAM1", "issues"]);

        data(await raw(panel, { method: "PUT", target: "/api/view", body: { tab: "board" } }));
        assert.equal((await action("get_view", {}, panel.id)).view.tab, "board");
        assert.equal((await action("get_view", {}, "ext-other")).view.space, "");
    });

    it("forget an instance when it closes", async () => {
        await action("set_view", { space: "KAN" }, "ext-lazy");
        assert.equal((await action("get_view", {}, "ext-lazy")).view.space, "KAN");
        await canvas.onClose({ instanceId: "ext-lazy" });
        assert.equal((await action("get_view", {}, "ext-lazy")).view.space, "");
    });

    it("report their failures as errors of the host", async () => {
        await assert.rejects(action("get_issue", { key: "nope" }), isCanvasError("invalid"));
        await assert.rejects(action("get_issue", { key: "KAN-999" }), isCanvasError("not_found"));
        await assert.rejects(action("set_view", { tab: "timeline" }), isCanvasError("invalid"));
    });
});

describe("without the Atlassian MCP server", () => {
    it("opens the panel anyway and says how to connect", async () => {
        captured.metadataHandler = () => ({ tools: [] });
        await forget();
        const panel = await open({ space: "KAN" });
        const response = await raw(panel, { target: "/api/spaces" });
        failure(response, 503, "not_connected", /Atlassian MCP server is not available.*https:\/\/mcp\.atlassian\.com\/v1\/mcp/);
        await assert.rejects(action("list_spaces"), isCanvasError("not_connected"));
        assert.deepEqual(captured.toolCalls, []);
    });

    it("says the same when this version of the app does not expose the session tools", async () => {
        const { tools } = captured.session.rpc;
        const original = tools.getCurrentMetadata;
        tools.getCurrentMetadata = undefined;
        try {
            await forget();
            const panel = await open({ space: "KAN" });
            failure(await raw(panel, { target: "/api/spaces" }), 503, "not_connected", /does not expose the session tools/);
            await assert.rejects(action("list_spaces"), isCanvasError("not_connected"));
        } finally {
            tools.getCurrentMetadata = original;
        }
    });
});

describe("starting a Copilot session from a work item", () => {
    const start = (panel, key, body) => raw(panel, { method: "POST", target: `/api/issues/${key}/session`, body });
    const hostCalls = () => captured.toolCalls.filter((call) => HOST_TOOLS.includes(call.name));
    const created = () => hostCalls().filter((call) => call.name === "create_session").map((call) => call.arguments);

    it("lists where it can start: this session's project, the projects of the app and a chat", async () => {
        const panel = await open({});
        const { targets, last } = data(await raw(panel, { target: "/api/targets" }));
        assert.deepEqual(targets.map((target) => [target.id, target.label]), [
            ["same", "This session's project"],
            ["project:proj-1", "jira-copilot-canvas"],
            ["chat", "Chat (no repository)"],
        ]);
        assert.equal(last, "");
    });

    it("offers the project of the session only when its folder is a repository", async () => {
        const plain = tempDir();
        const outside = await open({}, { cwd: plain });
        await outsideAnyRepository(plain, async () => {
            const { targets } = data(await raw(outside, { target: "/api/targets" }));
            assert.deepEqual(targets.map((target) => target.id), ["project:proj-1", "chat"]);
        });
    });

    it("creates it detached and in the mode of the intent, then brings it to the front", async () => {
        const panel = await open({ space: "KAN" });
        const result = data(await start(panel, "KAN-2", { target: "same", intent: "plan", notes: "Start with the tests." }));
        assert.deepEqual(result, { sessionId: CREATED, navigated: true, target: "same", name: "KAN-2: Task 2", key: "KAN-2", intent: "plan" });

        assert.deepEqual(hostCalls().map((call) => call.name), ["list_repositories", "create_session", "navigate_to"]);
        const { kickoff, ...rest } = created()[0];
        assert.deepEqual(rest, { name: "KAN-2: Task 2", detached: true, coordinate_with_creator: false, workspace_type: "worktree", execution_location: "local" });
        assert.deepEqual(Object.keys(kickoff).sort(), ["mode", "prompt"]);
        assert.equal(kickoff.mode, "plan");
        assert.match(kickoff.prompt, /Jira work item KAN-2 on acme/);
        assert.match(kickoff.prompt, /Notes from me:\nStart with the tests\./);
        assert.deepEqual(hostCalls()[2].arguments, { id: CREATED });
    });

    it("can create it in a project of the app, or in a chat without a repository", async () => {
        const panel = await open({});
        data(await start(panel, "KAN-2", { target: "project:proj-1", intent: "implement" }));
        data(await start(panel, "KAN-1", { target: "chat" }));
        const [project, chat] = created();
        assert.equal(project.project_id, "proj-1");
        assert.equal(project.workspace_type, "worktree");
        assert.equal(project.kickoff.mode, "interactive");
        assert.match(project.kickoff.prompt, /Implement this work item\./);
        assert.equal(chat.session_kind, "chat");
        assert.equal(chat.name, "KAN-1: Task 1");
        assert.deepEqual(["project_id", "workspace_type", "execution_location"].filter((field) => field in chat), []);
        assert.equal(chat.kickoff.mode, "interactive");
    });

    it("never creates it in autopilot", async () => {
        const panel = await open({});
        for (const intent of ["context", "plan", "implement"]) data(await start(panel, "KAN-2", { target: "chat", intent }));
        failure(await start(panel, "KAN-2", { target: "chat", intent: "autopilot" }), 400, "invalid", /intent must be one of/);
        assert.equal(created().length, 3);
        for (const args of created()) {
            assert.ok(["plan", "interactive"].includes(args.kickoff.mode), args.kickoff.mode);
            assert.doesNotMatch(JSON.stringify(args), /autopilot/i);
        }
    });

    it("says when the app could not create it, and does not go looking for it", async () => {
        host.create_session = () => failed("The quota of sessions is reached.");
        const panel = await open({});
        failure(await start(panel, "KAN-2", { target: "chat" }), 502, "upstream", /quota of sessions/);
        assert.deepEqual(hostCalls().map((call) => call.name), ["list_repositories", "create_session"]);
    });

    it("creates nothing when the work item does not exist or the target is unknown", async () => {
        const panel = await open({});
        failure(await start(panel, "KAN-999", { target: "chat" }), 404, "not_found");
        failure(await start(panel, "KAN-2", { target: "project:nope" }), 400, "invalid", /where/);
        failure(await start(panel, "KAN-2", {}), 400, "invalid", /where/);
        assert.deepEqual(created(), []);
    });
});
