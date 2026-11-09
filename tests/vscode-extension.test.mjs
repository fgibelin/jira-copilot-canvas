import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createMockAtlassian } from "./harness/mock-atlassian.mjs";
import { createRenderer } from "./harness/renderer.mjs";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHANNEL = "jira-canvas";
const UUID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// A page that never answers would otherwise wait forever, so that a regression hangs the run instead of failing it.
const SUITE = { timeout: 10_000 };

/** Loads the entry of the extension the way VS Code does, with `vscode` being the editor that is given. */
function loadExtension(vscode) {
    const file = require.resolve("../vscode/extension.cjs");
    delete require.cache[file];
    const load = Module._load;
    Module._load = function (request, ...rest) {
        return request === "vscode" ? vscode : load.call(this, request, ...rest);
    };
    try {
        return require(file);
    } finally {
        Module._load = load;
    }
}

async function eventually(check, what) {
    const deadline = Date.now() + 3000;
    for (;;) {
        const value = check();
        if (value) return value;
        assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** The servers that the canvas starts, so that a test can see whether they still listen. A server that a test leaves listening is closed, so that it cannot keep the run alive. */
function trackServers(t) {
    const servers = [];
    const listen = http.Server.prototype.listen;
    t.mock.method(http.Server.prototype, "listen", function (...args) {
        servers.push(this);
        return listen.apply(this, args);
    });
    t.after(() => {
        for (const server of servers) {
            server.close();
            server.closeAllConnections();
        }
    });
    return servers;
}

/** Takes over the timer that gives the page 30 seconds to start, so that a test can fire it, or see that it was cleared. */
function watchTimer(t) {
    const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
    const watched = { callback: null, handle: null, cleared: false };
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        if (ms !== 30_000) return realSetTimeout(callback, ms, ...args);
        watched.callback = callback;
        watched.handle = {};
        return watched.handle;
    });
    t.mock.method(globalThis, "clearTimeout", (handle) => {
        if (handle !== watched.handle) return realClearTimeout(handle);
        watched.cleared = true;
    });
    return watched;
}

/** The page of a panel: the real bridge of the renderer, wired to the extension the way a webview is, and started the way app.js starts it. */
function startPage(panel) {
    const events = [];
    const statuses = [];
    const failures = [];
    const page = createRenderer({
        onPost: (message) => setImmediate(() => Promise.resolve(panel.receive(message)).catch((error) => failures.push(error))),
    });
    page.bridge.connect((event, data) => events.push([event, data]), (status) => statuses.push(status));
    return { ...page, events, statuses, failures };
}

function createPanel(editor, { viewType, title, column, options }) {
    const disposeListeners = [];
    let receive = () => {};
    let html = "";
    const panel = {
        viewType,
        title,
        column,
        options,
        revealed: 0,
        disposed: false,
        posted: [],
        page: null,
        webview: {
            cspSource: "https://webview.test",
            asWebviewUri: (uri) => {
                if (editor.failAssets) throw new Error("The webview could not resolve its files.");
                return { toString: () => `https://webview.test/${path.relative(ROOT, uri.fsPath).split(path.sep).join("/")}` };
            },
            postMessage: async (message) => {
                if (panel.disposed) throw new Error("Webview is disposed");
                panel.posted.push(JSON.parse(JSON.stringify(message)));
                panel.page?.deliver(message);
                return true;
            },
            onDidReceiveMessage: (listener, thisArg, disposables) => {
                receive = listener;
                const subscription = { dispose() {} };
                disposables?.push(subscription);
                return subscription;
            },
            get html() {
                return html;
            },
            set html(value) {
                html = value;
                if (editor.renderer === "responsive") panel.page = startPage(panel);
            },
        },
        receive: (message) => receive(message),
        reveal: () => {
            panel.revealed++;
        },
        onDidDispose: (listener) => {
            disposeListeners.push(listener);
            return { dispose() {} };
        },
        dispose: () => {
            if (panel.disposed) return;
            panel.disposed = true;
            for (const listener of disposeListeners) listener();
        },
    };
    return panel;
}

/** What the extension uses of VS Code, with what it does recorded. `renderer` is "responsive" for a page that starts, or "silent" for one that never does. */
function createEditor({ trusted = true, atlassian = true, renderer = "responsive" } = {}) {
    const mock = createMockAtlassian();
    const tools = new Map();
    const commands = new Map();
    const atlassianTools = new Map(atlassian ? mock.toolList().map((tool) => [`mcp_atlassian_${tool.name}`, tool.id]) : []);
    const editor = {
        mock,
        tools,
        commands,
        trusted,
        renderer,
        failAssets: false,
        failPanel: false,
        panels: [],
        outputs: [],
        errors: [],
        executed: [],
        clipboard: [],
        get panel() {
            return this.panels.at(-1);
        },
    };
    editor.vscode = {
        window: {
            createOutputChannel: (name) => {
                const output = {
                    name,
                    lines: [],
                    appendLine: (line) => output.lines.push(line),
                    dispose() {},
                };
                editor.outputs.push(output);
                return output;
            },
            createWebviewPanel: (viewType, title, column, options) => {
                if (editor.failPanel) throw new Error("The webview could not be created.");
                const panel = createPanel(editor, { viewType, title, column, options });
                editor.panels.push(panel);
                return panel;
            },
            showErrorMessage: async (message) => {
                editor.errors.push(message);
            },
        },
        workspace: {
            get isTrusted() {
                return editor.trusted;
            },
        },
        commands: {
            registerCommand: (id, handler) => {
                commands.set(id, handler);
                return { dispose: () => commands.delete(id) };
            },
            executeCommand: async (id, ...args) => {
                if (commands.has(id)) return commands.get(id)(...args);
                editor.executed.push([id, ...args]);
            },
        },
        lm: {
            get tools() {
                return [...atlassianTools.keys(), ...tools.keys(), "copilot_readFile"].map((name) => ({ name }));
            },
            registerTool: (name, implementation) => {
                tools.set(name, implementation);
                return { dispose: () => tools.delete(name) };
            },
            invokeTool: async (name, options) => {
                const result = await mock.transport.invoke(atlassianTools.get(name), options.input);
                if (!result.ok) throw new Error(result.error ?? result.text);
                return { content: [{ value: result.text }, ...(result.structured ? [{ value: JSON.stringify(result.structured) }] : [])] };
            },
        },
        ViewColumn: { Beside: -2 },
        Uri: {
            file: (fsPath) => ({ fsPath }),
            joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) }),
        },
        env: {
            clipboard: {
                writeText: async (text) => {
                    editor.clipboard.push(text);
                },
            },
        },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            dispose() {}
        },
        CancellationError: class CancellationError extends Error {},
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
    return editor;
}

/** Activates the extension in a fresh editor, and closes whatever the test leaves open. */
async function activate(t, options) {
    const editor = createEditor(options);
    const extension = loadExtension(editor.vscode);
    const context = { extensionPath: ROOT, extensionUri: { fsPath: ROOT }, subscriptions: [] };
    t.after(async () => {
        await extension.deactivate();
        for (const panel of editor.panels) panel.dispose();
    });
    await extension.activate(context);
    return Object.assign(editor, {
        extension,
        context,
        open: (input) => editor.commands.get("jiraCanvas.open")(input),
        tool: (name, input = {}, token = { isCancellationRequested: false }) => editor.tools.get(`jira_canvas_${name}`).invoke({ input }, token),
    });
}

const answered = (reply) => ({ status: reply.status, payload: reply.payload });
const errorLines = (editor) => editor.outputs[0].lines.filter((line) => line.startsWith("[error]"));

describe("activating the extension", SUITE, () => {
    it("registers the command and the tools that the manifest declares, and opens nothing yet", async (t) => {
        const editor = await activate(t);
        assert.equal(manifest.main, "./vscode/extension.cjs");
        assert.deepEqual([...editor.commands.keys()], manifest.contributes.commands.map((command) => command.command));
        assert.deepEqual([...editor.tools.keys()].sort(), manifest.contributes.languageModelTools.map((tool) => tool.name).sort());
        assert.equal(editor.panels.length, 0);
        assert.deepEqual(editor.executed, []);
    });

    it("gives the editor everything it registers, to dispose of when the extension goes", async (t) => {
        const editor = await activate(t);
        assert.equal(editor.outputs.length, 1);
        assert.equal(editor.outputs[0].name, "Jira Canvas");
        assert.ok(editor.context.subscriptions.includes(editor.outputs[0]));
        for (const subscription of editor.context.subscriptions) subscription.dispose();
        assert.equal(editor.commands.size, 0);
        assert.equal(editor.tools.size, 0);
    });
});

describe("opening the canvas", SUITE, () => {
    it("opens a panel beside the editor, in which scripts run and only the files of the extension load", async (t) => {
        const editor = await activate(t);
        await editor.open();
        assert.equal(editor.panels.length, 1);
        const { viewType, title, column, options, webview } = editor.panel;
        assert.deepEqual({ viewType, title, column }, { viewType: "jiraCopilotCanvas", title: "Jira", column: editor.vscode.ViewColumn.Beside });
        assert.equal(options.enableScripts, true);
        assert.equal(options.retainContextWhenHidden, true);
        assert.deepEqual(
            options.localResourceRoots.map((root) => root.fsPath),
            [path.join(ROOT, "jira-copilot-canvas/public"), path.join(ROOT, "vscode")],
        );
        assert.match(webview.html, /<meta http-equiv="Content-Security-Policy"/);
        assert.match(webview.html, /href="https:\/\/webview\.test\/vscode\/theme\.css"/);
        assert.doesNotMatch(webview.html, /127\.0\.0\.1|localhost|\?k=/, "the page does not know where the server is");
    });

    it("answers when the page has started, with the state of the canvas, and stops waiting for the page", async (t) => {
        const timer = watchTimer(t);
        const editor = await activate(t);
        const state = await editor.open();
        assert.equal(state.instanceId, "vscode-jira");
        assert.equal(state.host, "VS Code");
        assert.equal(state.capabilities.openSession, true);
        assert.deepEqual(editor.panel.page.statuses, ["connecting", "live"]);
        assert.deepEqual(editor.panel.posted[0], { channel: CHANNEL, type: "event", event: "hello", data: { instanceId: "vscode-jira" } });
        assert.equal(timer.cleared, true);
        assert.deepEqual(editor.errors, []);
    });

    it("opens on the space and the tab it is asked for", async (t) => {
        const editor = await activate(t);
        const state = await editor.open({ space: "KAN", tab: "board" });
        assert.equal(state.view.space, "KAN");
        assert.equal(state.view.tab, "board");
    });

    it("shows the canvas that is open instead of opening another, and goes where it is asked to", async (t) => {
        const editor = await activate(t);
        await editor.open({ space: "KAN" });
        const again = await editor.open({ space: "KAN", issue: "KAN-2" });
        assert.equal(editor.panels.length, 1);
        assert.equal(editor.panel.revealed, 1);
        assert.equal(again.instanceId, "vscode-jira");
        assert.equal(again.view.issue, "KAN-2");
    });

    it("shares one panel between opens that arrive together", async (t) => {
        const servers = trackServers(t);
        const editor = await activate(t);
        const [first, second] = await Promise.all([editor.open(), editor.open()]);
        assert.equal(editor.panels.length, 1);
        assert.equal(servers.length, 1);
        assert.deepEqual(first, second);
    });

    it("does not open in a workspace that is not trusted, and opens once it is", async (t) => {
        const editor = await activate(t, { trusted: false });
        assert.equal(await editor.open(), undefined);
        assert.deepEqual(editor.errors, ["Jira canvas: Trust this workspace before opening the Jira canvas."]);
        assert.equal(editor.panels.length, 0);
        assert.equal(errorLines(editor).length, 1);

        editor.trusted = true;
        assert.equal((await editor.open()).instanceId, "vscode-jira");
        assert.equal(editor.errors.length, 1);
    });

    it("leaves nothing behind when its panel is closed, and opens a new one when it is asked again", async (t) => {
        const servers = trackServers(t);
        const editor = await activate(t);
        await editor.open();
        const closed = editor.panel;
        assert.equal(servers.length, 1);
        assert.equal(servers[0].listening, true);
        assert.ok(await editor.tool("list_spaces"));

        closed.dispose();
        await eventually(() => !servers[0].listening, "the server to stop");
        await assert.rejects(editor.tool("list_spaces"), { code: "not_open" });

        const state = await editor.open();
        assert.equal(state.instanceId, "vscode-jira");
        assert.equal(editor.panels.length, 2);
        assert.notEqual(editor.panel, closed);
        assert.equal(servers.length, 2);
        assert.equal(servers[1].listening, true);
        assert.ok(await editor.tool("list_spaces"));
    });
});

describe("the requests of the page", SUITE, () => {
    it("are answered through the server of the canvas, with the data of the Atlassian tools of the editor", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const reply = await editor.panel.page.bridge.request("GET", "/api/spaces");
        assert.equal(reply.channel, CHANNEL);
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.payload.data.spaces.map((space) => space.key), ["KAN", "SAM1"]);
        assert.ok(editor.mock.calls.length > 0);
        assert.deepEqual(editor.panel.page.failures, []);
    });

    it("carry their query and their body to the server", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const { bridge } = editor.panel.page;
        const issues = await bridge.request("GET", "/api/spaces/KAN/issues", { limit: 2 });
        assert.equal(issues.payload.data.items.length, 2);
        const view = await bridge.request("PUT", "/api/view", undefined, { tab: "board" });
        assert.equal(view.payload.data.tab, "board");
        assert.equal((await bridge.request("GET", "/api/state")).payload.data.view.tab, "board");
    });

    it("are answered with an error that the page can read when the extension refuses them, and the refusal is logged", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const reply = await editor.panel.page.bridge.request("DELETE", "/api/state");
        assert.deepEqual(answered(reply), { status: 500, payload: { ok: false, error: { code: "bridge_error", message: "Invalid canvas request" } } });
        assert.equal(reply.id, editor.panel.posted.at(-1).id);
        assert.equal(errorLines(editor).length, 1);
        assert.match(errorLines(editor)[0], /^\[error\] Error: Invalid canvas request/);
    });

    it("that are not meant for the extension get no answer", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const before = editor.panel.posted.length;
        const foreign = [undefined, null, "subscribe", 42, {}, { channel: "somebody-else", type: "request", id: UUID }, { channel: CHANNEL }, { channel: CHANNEL, type: "nope" }];
        for (const message of foreign) assert.equal(await editor.panel.receive(message), undefined);
        assert.equal(editor.panel.posted.length, before);
        assert.deepEqual(editor.panel.page.failures, []);
        assert.deepEqual(errorLines(editor), []);
    });

    it("that arrive after the panel was closed get no answer, which a closed webview would refuse", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const { panel } = editor;
        const before = panel.posted.length;
        const pending = panel.receive({ channel: CHANNEL, type: "request", id: UUID, method: "GET", path: "/api/spaces" });
        panel.dispose();
        await pending;
        assert.equal(panel.posted.length, before);
    });

    it("are refused when the workspace stops being trusted, and served again when it is trusted again", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const { bridge } = editor.panel.page;
        editor.trusted = false;
        const refused = await bridge.request("GET", "/api/spaces");
        assert.deepEqual(answered(refused), { status: 500, payload: { ok: false, error: { code: "bridge_error", message: "Workspace is not trusted." } } });
        await assert.rejects(editor.tool("list_spaces"), { message: "Trust this workspace before using the Jira tools." });
        assert.equal(await editor.open(), undefined);
        assert.deepEqual(editor.errors, ["Jira canvas: Trust this workspace before opening the Jira canvas."]);

        editor.trusted = true;
        assert.equal((await bridge.request("GET", "/api/spaces")).status, 200);
    });

    it("offer the chat of the editor as the place to start a session from a work item", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const targets = await editor.panel.page.bridge.request("GET", "/api/targets");
        assert.deepEqual(targets.payload.data.targets.map((target) => target.id), ["chat"]);
    });

    it("start a chat from a work item, with its prompt as a draft that waits for the person to send it", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const reply = await editor.panel.page.bridge.request("POST", "/api/issues/KAN-2/session", undefined, { target: "chat", intent: "context" });
        assert.equal(reply.status, 200);
        assert.equal(reply.payload.data.delivery, "prefilled");
        assert.equal(reply.payload.data.name, "KAN-2: Task 2");
        assert.deepEqual(
            editor.executed.map(([command]) => command),
            ["workbench.action.chat.newChat", "workbench.action.chat.open"],
        );
        const [, options] = editor.executed[1];
        assert.equal(options.isPartialQuery, true);
        assert.match(options.query, /Jira work item KAN-2/);
        assert.deepEqual(editor.clipboard, []);
    });

    it("do not start a session in a place the editor does not offer", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const reply = await editor.panel.page.bridge.request("POST", "/api/issues/KAN-2/session", undefined, { target: "project:elsewhere" });
        assert.equal(reply.status, 400);
        assert.equal(reply.payload.error.code, "invalid");
        assert.deepEqual(editor.executed, []);
    });

    it("learn how to reach Jira when the editor has no Atlassian MCP server", async (t) => {
        const editor = await activate(t, { atlassian: false });
        await editor.open();
        const reply = await editor.panel.page.bridge.request("GET", "/api/spaces");
        assert.equal(reply.status, 503);
        assert.equal(reply.payload.error.code, "not_connected");
        assert.match(reply.payload.error.message, /https:\/\/mcp\.atlassian\.com\/v1\/mcp/);
    });
});

describe("the tools of Copilot Chat", SUITE, () => {
    it("tell the model to open the canvas when it is not open, which is not an unexpected error", async (t) => {
        const editor = await activate(t);
        await assert.rejects(editor.tool("list_spaces"), (error) => {
            assert.equal(error.name, "AtlassianError");
            assert.equal(error.code, "not_open");
            assert.match(error.message, /Open the canvas first: run 'Jira: Open Jira Canvas' from the Command Palette\./);
            return true;
        });
        assert.deepEqual(editor.outputs[0].lines, []);
    });

    it("work on the canvas that is open, and the page hears what they change", async (t) => {
        const editor = await activate(t);
        await editor.open({ space: "KAN" });
        const shown = JSON.parse((await editor.tool("get_view")).content[0].value);
        assert.equal(shown.view.space, "KAN");

        await editor.tool("set_view", { tab: "board" });
        const [, change] = editor.panel.page.events.find(([event]) => event === "view");
        assert.equal(change.view.tab, "board");
        assert.deepEqual(change.changed, ["tab"]);
        assert.equal(JSON.parse((await editor.tool("get_view")).content[0].value).view.tab, "board");
    });

    it("read through the Atlassian tools of the editor", async (t) => {
        const editor = await activate(t);
        await editor.open();
        const spaces = JSON.parse((await editor.tool("list_spaces")).content[0].value);
        assert.deepEqual(spaces.spaces.map((space) => space.key), ["KAN", "SAM1"]);
        assert.ok(editor.mock.calls.length > 0);
    });
});

describe("a page that does not start", SUITE, () => {
    it("is given up on after 30 seconds, and nothing is left behind", async (t) => {
        const servers = trackServers(t);
        const timer = watchTimer(t);
        const editor = await activate(t, { renderer: "silent" });
        const opening = editor.open();
        await eventually(() => timer.callback, "the page to be given time to start");
        timer.callback();
        assert.equal(await opening, undefined);

        assert.deepEqual(editor.errors, ["Jira canvas: The canvas did not start. See the Jira Canvas output log."]);
        assert.match(errorLines(editor)[0], /^\[error\] Error: The canvas did not start\./, "the original error is the one that is reported");
        assert.equal(editor.panel.disposed, true);
        assert.equal(servers[0].listening, false);
        assert.equal(timer.cleared, true);
        await assert.rejects(editor.tool("list_spaces"), { code: "not_open" });

        editor.renderer = "responsive";
        assert.equal((await editor.open()).instanceId, "vscode-jira", "it can be opened again");
    });

    it("is given up on when its panel is closed before it has started", async (t) => {
        const timer = watchTimer(t);
        const editor = await activate(t, { renderer: "silent" });
        const opening = editor.open();
        await eventually(() => editor.panels[0]?.webview.html, "the page to be given to the panel");
        editor.panel.dispose();
        assert.equal(await opening, undefined);
        assert.deepEqual(editor.errors, ["Jira canvas: Canvas closed before its renderer was ready."]);
        assert.equal(timer.cleared, true, "it does not keep waiting");
        await assert.rejects(editor.tool("list_spaces"), { code: "not_open" });
    });

    it("is given up on when its files cannot be found, and the panel and the server are closed", async (t) => {
        const servers = trackServers(t);
        const editor = await activate(t);
        editor.failAssets = true;
        assert.equal(await editor.open(), undefined);
        assert.deepEqual(editor.errors, ["Jira canvas: The webview could not resolve its files."]);
        assert.equal(editor.panel.disposed, true);
        assert.equal(servers[0].listening, false);
        await assert.rejects(editor.tool("list_spaces"), { code: "not_open" });

        editor.failAssets = false;
        assert.equal((await editor.open()).instanceId, "vscode-jira");
        assert.equal(editor.panels.length, 2);
    });

    it("is given up on when the editor cannot create its panel, and the server is closed", async (t) => {
        const servers = trackServers(t);
        const editor = await activate(t);
        editor.failPanel = true;
        assert.equal(await editor.open(), undefined);
        assert.deepEqual(editor.errors, ["Jira canvas: The webview could not be created."]);
        assert.equal(editor.panels.length, 0);
        assert.equal(servers[0].listening, false);

        editor.failPanel = false;
        assert.equal((await editor.open()).instanceId, "vscode-jira");
    });
});

describe("deactivating the extension", SUITE, () => {
    it("closes the panel and the server of the canvas", async (t) => {
        const servers = trackServers(t);
        const editor = await activate(t);
        await editor.open();
        await editor.extension.deactivate();
        assert.equal(editor.panel.disposed, true);
        assert.equal(servers[0].listening, false);
        await assert.rejects(editor.tool("list_spaces"), { code: "not_open" });
    });

    it("has nothing to close when no canvas is open", async (t) => {
        const editor = await activate(t);
        await editor.extension.deactivate();
        assert.equal(editor.panels.length, 0);
        assert.deepEqual(editor.errors, []);
    });
});
