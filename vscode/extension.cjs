const vscode = require("vscode");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CHANNEL = "jira-canvas";
const INSTANCE_ID = "vscode-jira";
const RENDERER_TIMEOUT_MS = 30_000;

let active = null;
let opening = null;

exports.activate = async (context) => {
    const load = (relative) => import(pathToFileURL(path.join(context.extensionPath, relative)).href);
    const [{ createWorkbench }, { AtlassianError, createAtlassian }, { startServer }, { renderWebview, relayRequest }, { registerTools }, { createVsCodeTransport }, { createVsCodeLauncher }] = await Promise.all([
        load("jira-copilot-canvas/workbench.mjs"),
        load("jira-copilot-canvas/atlassian.mjs"),
        load("jira-copilot-canvas/server.mjs"),
        load("vscode/webview.mjs"),
        load("vscode/tools.mjs"),
        load("vscode/transport.mjs"),
        load("vscode/launcher.mjs"),
    ]);
    const output = vscode.window.createOutputChannel("Jira Canvas");
    const log = (level, message) => output.appendLine(`[${level}] ${message}`);
    context.subscriptions.push(output);

    // Jira and Confluence are read through the Atlassian MCP server that VS Code already exposes to Copilot Chat.
    const atlassian = createAtlassian({ transport: createVsCodeTransport(vscode) });

    // An AtlassianError, so that the model reads this message instead of a generic "unexpected error".
    const current = () => {
        if (!active) throw new AtlassianError("not_open", "Open the canvas first: run 'Jira: Open Jira Canvas' from the Command Palette.");
        return active;
    };

    async function open(input) {
        if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening the Jira canvas.");
        if (active) {
            active.workbench.navigate(input);
            active.panel.reveal();
            return active.workbench.describe();
        }
        const workbench = createWorkbench({ instanceId: INSTANCE_ID, input, atlassian, launcher: createVsCodeLauncher(vscode, { log }), host: "VS Code", log });
        let server;
        let panel;
        let ready;
        let rejectReady;
        let readyTimer;
        try {
            await workbench.init();
            server = await startServer({ publicDir: path.join(context.extensionPath, "jira-copilot-canvas/public"), workbench, log });
            panel = vscode.window.createWebviewPanel("jiraCopilotCanvas", "Jira", vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "jira-copilot-canvas/public"), vscode.Uri.joinPath(context.extensionUri, "vscode")],
            });
            const entry = { panel, workbench, server };
            active = entry;
            const unsubscribe = workbench.subscribe((type, data) => {
                panel.webview.postMessage({ channel: CHANNEL, type: "event", event: type, data }).then(undefined, (error) => log("warning", error.message));
            });
            panel.webview.onDidReceiveMessage(
                async (message) => {
                    if (message?.channel !== CHANNEL) return;
                    if (message.type === "subscribe") {
                        await panel.webview.postMessage({ channel: CHANNEL, type: "event", event: "hello", data: { instanceId: workbench.instanceId } });
                        ready?.();
                        return;
                    }
                    if (message.type !== "request") return;
                    let result;
                    try {
                        if (!vscode.workspace.isTrusted) throw new Error("Workspace is not trusted.");
                        result = await relayRequest(message, server);
                    } catch (error) {
                        log("error", error.stack ?? error.message);
                        result = { status: 500, payload: { ok: false, error: { code: "bridge_error", message: error.message } } };
                    }
                    if (active === entry) await panel.webview.postMessage({ channel: CHANNEL, id: message.id, ...result });
                },
                undefined,
                context.subscriptions,
            );
            panel.onDidDispose(() => {
                unsubscribe();
                rejectReady?.(new Error("Canvas closed before its renderer was ready."));
                workbench.close();
                if (active === entry) active = null;
                server.close().catch((error) => log("error", error.message));
            });
            const html = await renderWebview(panel.webview, context.extensionPath, vscode.Uri.file);
            const rendererReady = new Promise((resolve, reject) => {
                ready = resolve;
                rejectReady = reject;
                readyTimer = setTimeout(() => reject(new Error("The canvas did not start. See the Jira Canvas output log.")), RENDERER_TIMEOUT_MS);
            });
            panel.webview.html = html;
            await rendererReady;
            return workbench.describe();
        } catch (error) {
            panel?.dispose();
            workbench.close();
            await server?.close();
            throw error;
        } finally {
            clearTimeout(readyTimer);
            ready = rejectReady = null;
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("jiraCanvas.open", async (input) => {
            opening ??= open(input).finally(() => {
                opening = null;
            });
            try {
                return await opening;
            } catch (error) {
                log("error", error.stack ?? error.message);
                await vscode.window.showErrorMessage(`Jira canvas: ${error.message}`);
            }
        }),
    );
    registerTools(vscode, context, current, log);
};

exports.deactivate = async () => {
    const entry = active;
    active = null;
    entry?.workbench.close();
    entry?.panel.dispose();
    await entry?.server.close();
};
