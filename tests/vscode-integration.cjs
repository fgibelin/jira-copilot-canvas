"use strict";
// Runs inside a real VS Code extension host (scripts/test-vscode.mjs). It drives the extension through the surfaces a user
// and Copilot Chat use: the command, the editor tabs, the language model tools and the chat commands.
// The host has no Atlassian MCP server, so everything that reaches Jira must report that cleanly instead of failing.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");

const EXTENSION_ID = "fgibelin.jira-copilot-canvas";
const CHAT_COMMANDS = ["workbench.action.chat.newChat", "workbench.action.chat.open"];

const extension = () => vscode.extensions.getExtension(EXTENSION_ID);
const jiraTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.label === "Jira" && tab.input instanceof vscode.TabInputWebview);
const declaredTools = () => extension().packageJSON.contributes.languageModelTools.map((tool) => tool.name);

async function callTool(name, input = {}) {
    const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
    return result.content.map((part) => part.value ?? "").join("");
}

const checks = [
    ["is installed under its published id", async () => {
        assert.ok(extension(), `${EXTENSION_ID} was not found in the development host`);
    }],

    ["activates without errors", async () => {
        await extension().activate();
        assert.equal(extension().isActive, true);
    }],

    ["registers the command that opens the canvas", async () => {
        assert.ok((await vscode.commands.getCommands(true)).includes("jiraCanvas.open"));
    }],

    ["exposes all the tools its manifest declares to Copilot Chat", async () => {
        const exposed = new Set(vscode.lm.tools.map((tool) => tool.name));
        assert.equal(declaredTools().length, 17);
        assert.deepEqual(declaredTools().filter((name) => !exposed.has(name)), []);
    }],

    ["tells a tool call that arrives before the canvas is open how to open it", async () => {
        await assert.rejects(callTool("jira_canvas_get_view"), /Open the canvas first/);
    }],

    ["opens the canvas in a webview tab once its page has loaded", async () => {
        const state = await vscode.commands.executeCommand("jiraCanvas.open");
        assert.ok(state, "the command returned nothing: the canvas did not open (see the Jira Canvas output log)");
        assert.equal(state.instanceId, "vscode-jira");
        assert.equal(state.host, "VS Code");
        assert.equal(state.capabilities.openSession, true);
        assert.equal(jiraTabs().length, 1);
    }],

    ["opens the canvas that is already there instead of a second one", async () => {
        const state = await vscode.commands.executeCommand("jiraCanvas.open", { space: "KAN", tab: "issues" });
        assert.equal(state.instanceId, "vscode-jira");
        assert.equal(jiraTabs().length, 1);
    }],

    ["answers a tool call about what the panel shows", async () => {
        const { view } = JSON.parse(await callTool("jira_canvas_get_view"));
        assert.equal(view.space, "KAN");
        assert.equal(view.tab, "issues");
    }],

    ["reports that Atlassian is not connected rather than failing obscurely", async () => {
        await assert.rejects(callTool("jira_canvas_list_spaces"), /Atlassian/i);
    }],

    ["knows the chat commands it uses to hand a work item to Copilot", async () => {
        const known = new Set(await vscode.commands.getCommands(true));
        assert.deepEqual(CHAT_COMMANDS.filter((command) => !known.has(command)), []);
    }],

    ["fills in a new chat without sending it and without touching the clipboard", async () => {
        const { createVsCodeLauncher } = await import(pathToFileURL(path.join(extension().extensionPath, "vscode/launcher.mjs")).href);
        const copied = [];
        const host = { commands: vscode.commands, env: { clipboard: { writeText: async (text) => void copied.push(text) } } };
        const result = await createVsCodeLauncher(host).launch({ target: "chat", name: "KAN-1: Example", prompt: "Review KAN-1 and suggest a plan." });
        assert.equal(result.delivery, "prefilled");
        assert.deepEqual(copied, []);
    }],

    ["leaves no tab behind when the editors are closed", async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        assert.equal(jiraTabs().length, 0);
    }],
];

exports.run = async () => {
    const failures = [];
    for (const [name, check] of checks) {
        try {
            await check();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push(name);
            console.log(`FAIL ${name}\n     ${error?.stack ?? error}`);
        }
    }
    console.log(`${checks.length - failures.length} of ${checks.length} checks passed.`);
    if (failures.length) throw new Error(`Failed: ${failures.join("; ")}`);
};
