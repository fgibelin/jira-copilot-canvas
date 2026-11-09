// Loopback HTTP server behind one canvas panel: serves the UI and a small JSON API that is protected by a random token.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AtlassianError } from "./atlassian.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SSE_CLIENTS = 8;
const HEARTBEAT_MS = 25_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-canvas-token", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Max-Age": "600" };
const STATUS_BY_CODE = { invalid: 400, auth: 403, forbidden: 403, not_found: 404, not_connected: 503, unsupported: 501, rate_limited: 429, timeout: 504, upstream: 502 };

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const digest = (value) => createHash("sha256").update(String(value)).digest();
const tokenValid = (given, expected) => typeof given === "string" && timingSafeEqual(digest(given), expected);
const hostnameOf = (value) => {
    const host = String(value ?? "").trim().toLowerCase();
    return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
};
const originAllowed = (origin) => {
    if (origin === undefined || origin === "null") return true;
    try {
        const url = new URL(origin);
        return url.protocol === "http:" && LOOPBACK.has(hostnameOf(url.host));
    } catch {
        return false;
    }
};

const statusFor = (error) => error.status ?? STATUS_BY_CODE[error.code] ?? 502;

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "The request body is too large.");
        chunks.push(chunk);
    }
    if (!size) return {};
    let value;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "invalid", "The request body is not valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid", "The request body must be a JSON object.");
    return value;
}

/** Reads index.html, app.css and js/ into memory so that a running panel keeps serving a consistent set of files. */
export async function loadPublicAssets(publicDir) {
    const assets = new Map();
    const root = path.resolve(publicDir);
    const add = async (absolute) => assets.set(absolute, await readFile(absolute));
    await add(path.join(root, "index.html"));
    await add(path.join(root, "app.css"));
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(absolute);
            else if (entry.isFile()) await add(absolute);
        }
    };
    await walk(path.join(root, "js"));
    return assets;
}

const q = (query, name) => (typeof query[name] === "string" ? query[name] : undefined);

// [method, path pattern, handler]. The pattern is also the allow-list of the VS Code webview relay.
const routes = [
    ["GET", /^\/api\/state$/, ({ workbench }) => workbench.describe()],
    ["GET", /^\/api\/sites$/, ({ workbench }) => workbench.sites()],
    ["GET", /^\/api\/spaces$/, ({ workbench, query }) => workbench.spaces(query)],
    ["GET", /^\/api\/spaces\/([^/]+)\/summary$/, ({ workbench, params, query }) => workbench.summary({ ...query, space: params[0] })],
    ["GET", /^\/api\/spaces\/([^/]+)\/issues$/, ({ workbench, params, query }) => workbench.issues({ ...query, space: params[0] })],
    ["GET", /^\/api\/spaces\/([^/]+)\/versions$/, ({ workbench, params, query }) => workbench.versions({ ...query, space: params[0] })],
    ["GET", /^\/api\/spaces\/([^/]+)\/components$/, ({ workbench, params, query }) => workbench.components({ ...query, space: params[0] })],
    ["GET", /^\/api\/spaces\/([^/]+)\/boards$/, ({ workbench, params, query }) => workbench.boards({ ...query, space: params[0] })],
    ["GET", /^\/api\/boards$/, ({ workbench, query }) => workbench.boards(query)],
    ["GET", /^\/api\/boards\/([^/]+)$/, ({ workbench, params, query }) => workbench.board({ ...query, id: params[0] })],
    ["GET", /^\/api\/issues\/([^/]+)$/, ({ workbench, params, query }) => workbench.issue({ ...query, key: params[0] })],
    ["GET", /^\/api\/issues\/([^/]+)\/comments$/, ({ workbench, params, query }) => workbench.comments({ ...query, key: params[0] })],
    ["POST", /^\/api\/issues\/([^/]+)\/session$/, ({ workbench, params, body, query }) => workbench.openSession({ site: q(query, "site"), ...body, key: params[0] })],
    ["GET", /^\/api\/targets$/, ({ workbench }) => workbench.targets()],
    ["GET", /^\/api\/confluence\/spaces$/, ({ workbench, query }) => workbench.confluenceSpaces(query)],
    ["GET", /^\/api\/confluence\/spaces\/([^/]+)\/pages$/, ({ workbench, params, query }) => workbench.confluencePages({ ...query, space: params[0] })],
    ["GET", /^\/api\/confluence\/pages\/([^/]+)$/, ({ workbench, params, query }) => workbench.confluencePage({ ...query, id: params[0] })],
    ["GET", /^\/api\/confluence\/search$/, ({ workbench, query }) => workbench.confluenceSearch(query)],
    ["PUT", /^\/api\/view$/, ({ workbench, body }) => workbench.setView(body, { broadcast: false })],
    ["POST", /^\/api\/refresh$/, ({ workbench }) => workbench.refresh()],
    ["GET", /^\/api\/diagnose$/, ({ workbench, query }) => workbench.diagnose(query)],
];

/** True when `method` + `pathname` is an endpoint of the canvas API. */
export const isApiRequest = (method, pathname) => routes.some(([verb, pattern]) => verb === method && pattern.test(pathname));

const decode = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new HttpError(400, "invalid", "The request path is not valid.");
    }
};

async function handleApi(req, res, url, { workbench }) {
    const method = req.method ?? "GET";
    let matched = false;
    for (const [verb, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        matched = true;
        if (verb !== method) continue;
        let body = {};
        if (["POST", "PUT", "PATCH"].includes(method)) {
            if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Send application/json.");
            body = await readJson(req);
        }
        await workbench.init();
        const data = await handler({ workbench, params: match.slice(1).map(decode), body, query: Object.fromEntries(url.searchParams) });
        return reply(res, 200, { ok: true, data }, CORS_HEADERS);
    }
    if (matched) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    throw new HttpError(404, "not_found", "Unknown endpoint.");
}

function reply(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { ...BASE_HEADERS, ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}

function sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startServer({ publicDir, workbench, assets, log = () => {} }) {
    const token = randomBytes(16).toString("hex");
    const expected = digest(token);
    const root = path.resolve(publicDir);
    const files = assets ?? (await loadPublicAssets(publicDir));
    const clients = new Set();

    const serveFile = (res, relative, extra = {}) => {
        const absolute = path.resolve(root, relative);
        const content = absolute.startsWith(root + path.sep) ? files.get(absolute) : undefined;
        if (!content) throw new HttpError(404, "not_found", "Not found.");
        res.writeHead(200, { ...BASE_HEADERS, ...extra, "Content-Type": MIME[path.extname(absolute)] ?? "application/octet-stream", "Content-Length": content.length });
        res.end(content);
    };

    const openEventStream = (res) => {
        if (clients.size >= MAX_SSE_CLIENTS) {
            const oldest = clients.values().next().value;
            clients.delete(oldest);
            oldest.end();
        }
        res.writeHead(200, { ...BASE_HEADERS, ...CORS_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        clients.add(res);
        res.on("close", () => clients.delete(res));
        sendEvent(res, "hello", { instanceId: workbench.instanceId });
    };

    async function onRequest(req, res) {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!LOOPBACK.has(hostnameOf(req.headers.host))) throw new HttpError(403, "forbidden", "Unexpected host.");
        const api = url.pathname.startsWith("/api/") || url.pathname === "/events";
        if (api) {
            if (!originAllowed(req.headers.origin)) throw new HttpError(403, "forbidden", "Unexpected origin.");
            if (req.method === "OPTIONS") {
                res.writeHead(204, { ...BASE_HEADERS, ...CORS_HEADERS });
                return res.end();
            }
            const given = req.headers["x-canvas-token"] ?? (url.pathname === "/events" ? url.searchParams.get("k") : undefined);
            if (!tokenValid(given, expected)) throw new HttpError(401, "unauthorized", "Missing or invalid canvas token.");
            if (url.pathname === "/events") {
                if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
                return openEventStream(res);
            }
            return handleApi(req, res, url, { workbench });
        }
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
        if (url.pathname === "/" || url.pathname === "/index.html") return serveFile(res, "index.html", { "Content-Security-Policy": CSP });
        if (url.pathname === "/app.css") return serveFile(res, "app.css", { "Access-Control-Allow-Origin": "*" });
        if (url.pathname.startsWith("/js/")) return serveFile(res, url.pathname.slice(1), { "Access-Control-Allow-Origin": "*" });
        throw new HttpError(404, "not_found", "Not found.");
    }

    const server = http.createServer((req, res) => {
        onRequest(req, res).catch((error) => {
            let status;
            let code;
            let message;
            if (error instanceof HttpError || error instanceof AtlassianError) {
                status = statusFor(error);
                code = error.code;
                message = error.message;
            } else {
                log("error", `Unexpected error in the canvas server: ${error?.stack ?? error}`);
                status = 500;
                code = "internal";
                message = "Unexpected error in the canvas server.";
            }
            if (res.headersSent) return res.destroy();
            reply(res, status, { ok: false, error: { code, message } }, CORS_HEADERS);
            if (status === 413) res.once("finish", () => req.destroy());
        });
    });

    const unsubscribe = workbench.subscribe((type, data) => {
        for (const client of clients) sendEvent(client, type, data);
    });
    const heartbeat = setInterval(() => {
        for (const client of clients) client.write(": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref();

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}/?k=${token}`,
        port,
        token,
        close() {
            unsubscribe();
            clearInterval(heartbeat);
            for (const client of clients) client.end();
            clients.clear();
            return new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        },
    };
}
