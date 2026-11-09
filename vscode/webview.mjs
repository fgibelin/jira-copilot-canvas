import { readFile } from "node:fs/promises";
import path from "node:path";
import { isApiRequest } from "../jira-copilot-canvas/server.mjs";

const PUBLIC = "jira-copilot-canvas/public";
const METHODS = new Set(["GET", "POST", "PUT"]);
const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 175_000;

const escape = (text) => String(text).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Turns the canvas page into a webview document: a strict CSP, webview URIs for the assets and the VS Code theme mapping. */
export async function renderWebview(webview, root, uriFile) {
    const asset = (relative) => escape(webview.asWebviewUri(uriFile(path.join(root, relative))).toString());
    const html = await readFile(path.join(root, PUBLIC, "index.html"), "utf8");
    const policy = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src https: data:; font-src ${webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';`;
    return html
        .replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${escape(policy)}">`)
        .replace('href="/app.css"', `href="${asset(`${PUBLIC}/app.css`)}"`)
        .replace("</head>", `<link rel="stylesheet" href="${asset("vscode/theme.css")}">\n</head>`)
        .replace('src="/js/app.js"', `src="${asset(`${PUBLIC}/js/app.js`)}"`);
}

// A webview cannot reach the loopback server, so the extension forwards its requests. Only the canvas API is reachable,
// and only with a plain path: no query string (it travels separately), no dot segments (a URL parser also resolves the
// percent-encoded ones, which would send the request to a different route than the one that was checked).
const dotSegment = (part) => /^(?:\.|%2e){1,2}$/i.test(part);
const validPath = (method, value) => typeof value === "string" && !/[?#\\]/.test(value) && !value.split("/").some(dotSegment) && isApiRequest(method, value);

export async function relayRequest(message, server) {
    const { id, method, path: requested, query, body } = message ?? {};
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || !METHODS.has(method) || !validPath(method, requested)) throw new Error("Invalid canvas request");
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) throw new Error("Canvas request exceeds 1 MiB");
    const url = new URL(requested, server.url);
    for (const [key, values] of Object.entries(query ?? {})) {
        for (const value of Array.isArray(values) ? values : [values]) {
            if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
        }
    }
    const response = await fetch(url, {
        method,
        headers: { "x-canvas-token": server.token, "content-type": "application/json" },
        body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, payload: await response.json() };
}
