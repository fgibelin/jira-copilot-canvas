// Jira and Confluence canvas for the Copilot app.
//
// Jira and Confluence are reached through the Atlassian MCP server the session already has, so there is no token to
// configure here. One workbench (view state + Atlassian access) and one loopback server exist per open panel. The panel
// UI lives in ./public; the agent drives the same workbench through the actions in ./actions.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { buildActions } from "./actions.mjs";
import { AtlassianError, createAtlassian } from "./atlassian.mjs";
import { createCopilotTransport } from "./copilot-transport.mjs";
import { loadPublicAssets, startServer } from "./server.mjs";
import { createCopilotLauncher } from "./session-launch.mjs";
import { TABS, createWorkbench } from "./workbench.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PUBLIC_ASSETS = await loadPublicAssets(PUBLIC_DIR);

let session = null;

// stdout belongs to the JSON-RPC channel, so diagnostics go through the session log (and stderr for errors).
function log(level, message) {
    if (level === "error") console.error(`[jira-copilot-canvas] ${message}`);
    session?.log(message, { level, ephemeral: true }).catch(() => {});
}

// `session` is read on every call because the extension joins the session after this module has loaded.
const atlassian = createAtlassian({ transport: createCopilotTransport({ getSession: () => session }) });

/** instanceId -> { workbench, server, starting } */
const entries = new Map();

const workingDirectory = (ctx) => ctx.session?.workingDirectory ?? process.cwd();
const inputOf = (ctx) => (ctx.input && typeof ctx.input === "object" ? ctx.input : {});

function entryFor(ctx) {
    let entry = entries.get(ctx.instanceId);
    if (!entry) {
        const cwd = workingDirectory(ctx);
        const launcher = createCopilotLauncher({ getSession: () => session, getCwd: () => cwd, log });
        entry = { workbench: createWorkbench({ instanceId: ctx.instanceId, input: inputOf(ctx), atlassian, launcher, host: "Copilot", log }), server: null, starting: null };
        entries.set(ctx.instanceId, entry);
    }
    return entry;
}

// Several `open` calls can arrive together (host re-open, provider reconnect); they must share one server.
function ensureServer(entry) {
    if (entry.server) return Promise.resolve(entry.server);
    entry.starting ??= startServer({ publicDir: PUBLIC_DIR, assets: PUBLIC_ASSETS, workbench: entry.workbench, log })
        .then((server) => {
            entry.server = server;
            return server;
        })
        .finally(() => {
            entry.starting = null;
        });
    return entry.starting;
}

async function disposeEntry(instanceId) {
    const entry = entries.get(instanceId);
    if (!entry) return;
    entries.delete(instanceId);
    entry.workbench.close();
    const server = entry.server ?? (await entry.starting?.catch(() => null)) ?? null;
    await server?.close();
}

const asCanvasError = (error) => (error instanceof AtlassianError ? new CanvasError(error.code, error.message) : error);

const canvas = createCanvas({
    id: "jira-copilot-canvas",
    displayName: "Jira & Confluence",
    description: "Browse Jira boards, the issues and the sections of a Jira space, and Confluence pages, through the Atlassian MCP server. Open any work item as a new Copilot session.",
    inputSchema: {
        type: "object",
        properties: {
            site: { type: "string", maxLength: 200, description: "Atlassian site (cloud id, URL or name). Defaults to the first accessible site." },
            space: { type: "string", maxLength: 40, description: "Jira space (project) key to open, such as KAN." },
            issue: { type: "string", maxLength: 40, description: "Issue key to open in the detail drawer, such as KAN-12." },
            tab: { type: "string", enum: [...TABS], description: "Section of the space to show." },
        },
    },
    actions: buildActions({ workbenchFor: (ctx) => entryFor(ctx).workbench, log, ErrorClass: CanvasError }),

    open: async (ctx) => {
        let entry;
        try {
            const existing = entries.has(ctx.instanceId);
            entry = entryFor(ctx);
            if (existing) entry.workbench.navigate(inputOf(ctx));
        } catch (error) {
            throw asCanvasError(error);
        }
        let server;
        try {
            server = await ensureServer(entry);
        } catch (error) {
            log("error", `Could not start the canvas server: ${error?.stack ?? error}`);
            throw new CanvasError("server_failed", `Could not start the canvas server: ${error?.message ?? error}`);
        }
        await entry.workbench.init();
        const { space } = entry.workbench.getView();
        return { url: server.url, title: "Jira", status: space ? `Jira · ${space}` : "Jira" };
    },

    onClose: async (ctx) => {
        await disposeEntry(ctx.instanceId).catch((error) => log("warning", `Closing ${ctx.instanceId} failed: ${error?.message ?? error}`));
    },
});

session = await joinSession({ canvases: [canvas] });
log("info", "Jira canvas ready.");
