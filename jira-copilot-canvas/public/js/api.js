// Talks to the extension's loopback server. The per-panel token comes from the URL the host opened (`?k=`).
// In VS Code the same calls travel through the webview bridge instead.
import { bridge } from "./vscode-bridge.js";

const search = new URLSearchParams(location.search);
export const token = search.get("k") ?? "";
export const authorized = Boolean(token || bridge);

export class ApiError extends Error {
    constructor(code, message, status = 0) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}

// Every data request names the Atlassian site explicitly, so a request never races the view update that switched it.
let currentSite = "";
export const useSite = (site) => {
    currentSite = site ?? "";
};
const SITE_FREE = /^\/api\/(?:state|view|refresh|targets)$/;

function responseData(status, payload) {
    if (!payload?.ok) {
        if (status === 404 && payload?.error?.code === "not_found" && payload.error.message === "Unknown endpoint.") {
            const restart = bridge ? "Reload the VS Code window" : "Start a new Copilot session";
            throw new ApiError("outdated_server", `This canvas is using an older extension server. ${restart}, then reopen the Jira canvas. Refreshing this panel is not enough.`, status);
        }
        throw new ApiError(payload?.error?.code ?? "error", payload?.error?.message ?? "The request failed.", status);
    }
    return payload.data;
}

async function request(method, path, { query = {}, body } = {}) {
    const params = currentSite && !SITE_FREE.test(path) ? { site: currentSite, ...query } : query;
    if (bridge) {
        const { status, payload } = await bridge.request(method, path, params, body);
        return responseData(status, payload);
    }
    if (!token) throw new ApiError("no_token", "This page was opened without its access token. Reopen the canvas from the Copilot app.", 0);
    const url = new URL(path, location.href);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { "x-canvas-token": token };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response;
    try {
        response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    } catch {
        throw new ApiError("network", "Could not reach the canvas server. It may have been restarted: reopen the canvas.");
    }
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new ApiError("bad_response", `Unexpected response from the canvas server (HTTP ${response.status}).`, response.status);
    }
    return responseData(response.status, payload);
}

const enc = encodeURIComponent;

export const api = {
    state: () => request("GET", "/api/state"),
    sites: () => request("GET", "/api/sites"),
    spaces: () => request("GET", "/api/spaces"),
    summary: (space) => request("GET", `/api/spaces/${enc(space)}/summary`),
    issues: (space, filters = {}, cursor) => request("GET", `/api/spaces/${enc(space)}/issues`, { query: { ...filters, cursor } }),
    versions: (space) => request("GET", `/api/spaces/${enc(space)}/versions`),
    components: (space) => request("GET", `/api/spaces/${enc(space)}/components`),
    boards: (space) => request("GET", space ? `/api/spaces/${enc(space)}/boards` : "/api/boards"),
    board: (id, { backlog = false, cursor } = {}) => request("GET", `/api/boards/${enc(id)}`, { query: { backlog: backlog ? "1" : "", cursor } }),
    issue: (key) => request("GET", `/api/issues/${enc(key)}`),
    comments: (key, start) => request("GET", `/api/issues/${enc(key)}/comments`, { query: { start } }),
    targets: () => request("GET", "/api/targets"),
    openSession: (key, body) => request("POST", `/api/issues/${enc(key)}/session`, { body }),
    confluenceSpaces: () => request("GET", "/api/confluence/spaces"),
    confluencePages: (space, cursor) => request("GET", `/api/confluence/spaces/${enc(space)}/pages`, { query: { cursor } }),
    confluencePage: (id) => request("GET", `/api/confluence/pages/${enc(id)}`),
    confluenceSearch: (q, cursor) => request("GET", "/api/confluence/search", { query: { q, cursor } }),
    setView: (patch) => request("PUT", "/api/view", { body: patch }),
    refresh: () => request("POST", "/api/refresh", { body: {} }),
    diagnose: () => request("GET", "/api/diagnose"),
};

/** Opens the SSE stream. Returns a function that closes it. */
export function connectEvents(onEvent, onStatus) {
    if (bridge) return bridge.connect(onEvent, onStatus);
    if (!token) {
        onStatus("closed");
        return () => {};
    }
    const source = new EventSource(`/events?k=${encodeURIComponent(token)}`);
    source.addEventListener("open", () => onStatus("live"));
    source.addEventListener("error", () => onStatus(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting"));
    for (const type of ["hello", "changed", "view"]) {
        source.addEventListener(type, (event) => {
            let data = null;
            try {
                data = JSON.parse(event.data);
            } catch {
                /* ignore malformed payloads */
            }
            onEvent(type, data);
        });
    }
    return () => source.close();
}
