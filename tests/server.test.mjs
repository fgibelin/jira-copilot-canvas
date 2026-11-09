import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { AtlassianError, NOT_CONNECTED, createAtlassian } from "../jira-copilot-canvas/atlassian.mjs";
import { isApiRequest, loadPublicAssets, startServer } from "../jira-copilot-canvas/server.mjs";
import { DEFAULT_VIEW, createWorkbench } from "../jira-copilot-canvas/workbench.mjs";
import { ALICE, createMockAtlassian } from "./harness/mock-atlassian.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("../jira-copilot-canvas/public/", import.meta.url));
const MIB = 1024 * 1024;

const servers = [];
const workbenches = [];
const streams = [];
const folders = [];
after(async () => {
    for (const stream of streams) stream.close();
    for (const server of servers) await server.close();
    for (const workbench of workbenches) workbench.close?.();
    for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

function fakeLauncher(overrides = {}) {
    const launches = [];
    return {
        launches,
        targets: async () => [
            { id: "same", kind: "same", label: "This session's project", detail: "repo" },
            { id: "chat", kind: "chat", label: "Chat (no repository)", detail: "" },
        ],
        launch: async (request) => {
            launches.push(request);
            if (request.target !== "same" && request.target !== "chat") throw new AtlassianError("invalid", "Choose where the session should start.");
            return { sessionId: "session-1", navigated: true, target: request.target };
        },
        ...overrides,
    };
}

/** A panel's server over a real workbench that reads from the in-memory Atlassian. */
async function start({ launcher = fakeLauncher(), mockOptions, workbench, publicDir = PUBLIC_DIR, assets, log } = {}) {
    const atlassianMock = createMockAtlassian(mockOptions);
    const panel = workbench ?? createWorkbench({ instanceId: "srv-1", atlassian: createAtlassian({ transport: atlassianMock.transport }), launcher, host: "Test", log });
    workbenches.push(panel);
    const server = await startServer({ publicDir, workbench: panel, assets, log });
    servers.push(server);
    return { server, workbench: panel, mock: atlassianMock, launcher };
}

/** A workbench that answers nothing by itself: for the tests of how the server treats what a workbench throws. */
const stub = (overrides = {}) => ({ instanceId: "stub", init: async () => {}, subscribe: () => () => {}, describe: () => ({ stub: true }), ...overrides });

/** One HTTP request, with full control of the headers (fetch would not let us set Host or Origin). */
function raw(server, { method = "GET", target = "/", headers = {}, body, setHost = true } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: server.port, method, path: target, headers, setHost }, (response) => {
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
        request.end(body);
    });
}

/** A request written by hand: HTTP/1.0 is the one case where a request may have no Host header at all. */
function rawSocket(server, request) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(server.port, "127.0.0.1", () => socket.end(request));
        const chunks = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", reject);
        socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

/** A request to the API with the panel's token. */
const api = (server, target, { token = server.token, headers = {}, ...rest } = {}) => raw(server, { target, headers: { "x-canvas-token": token, ...headers }, ...rest });
const send = (server, method, target, body, options = {}) => api(server, target, { method, headers: { "content-type": "application/json", ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body), ...options });

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

function parseFrame(text) {
    const frame = { raw: text, event: "message", data: undefined, comment: undefined, retry: undefined };
    for (const line of text.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("event:")) frame.event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice("data:".length));
        else if (line.startsWith("retry:")) frame.retry = Number(line.slice("retry:".length));
    }
    return frame;
}

/** Opens `/events` and keeps every frame it receives. */
function openStream(server, { target = `/events?k=${server.token}`, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: server.port, path: target, headers }, (response) => {
            const frames = [];
            const waiting = new Set();
            let buffer = "";
            let finished = false;
            const ended = new Promise((done) =>
                response.on("close", () => {
                    finished = true;
                    done();
                }),
            );
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                buffer += chunk;
                for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
                    frames.push(parseFrame(buffer.slice(0, at)));
                    buffer = buffer.slice(at + 2);
                }
                for (const check of [...waiting]) check();
            });
            const stream = {
                status: response.statusCode,
                headers: response.headers,
                frames,
                ended,
                get finished() {
                    return finished;
                },
                waitFor(predicate, ms = 3_000) {
                    return new Promise((done, fail) => {
                        const timer = setTimeout(() => {
                            waiting.delete(check);
                            fail(new Error(`No matching event within ${ms} ms. Received: ${JSON.stringify(frames.map((frame) => frame.event))}`));
                        }, ms);
                        const check = () => {
                            const found = frames.find(predicate);
                            if (!found) return;
                            clearTimeout(timer);
                            waiting.delete(check);
                            done(found);
                        };
                        waiting.add(check);
                        check();
                    });
                },
                close: () => request.destroy(),
            };
            streams.push(stream);
            resolve(stream);
        });
        request.on("error", reject);
        request.end();
    });
}

const eventNamed = (name) => (frame) => frame.event === name;

/** Waits until a marker event, sent after the thing under test, has arrived: whatever the server was going to send before it has been sent. */
async function settle(stream, workbench) {
    const marker = `marker-${stream.frames.length}`;
    workbench.emit(marker, {});
    await stream.waitFor(eventNamed(marker));
}

function publicFolder(files) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jira-canvas-public-"));
    folders.push(folder);
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
        fs.writeFileSync(path.join(folder, name), content);
    }
    return folder;
}

const manyComments = (count) => Array.from({ length: count }, (_, index) => ({ id: String(100 + index), author: ALICE, body: `c${index + 1}`, created: `2026-11-01T00:${String(index).padStart(2, "0")}:00.000+0000` }));

describe("loading the public files", () => {
    it("reads the page, the style sheet and every script into memory", async () => {
        const assets = await loadPublicAssets(PUBLIC_DIR);
        const root = path.resolve(PUBLIC_DIR);
        const scripts = fs.readdirSync(path.join(root, "js")).filter((name) => name.endsWith(".js"));
        assert.ok(scripts.length >= 10 && scripts.includes("app.js"));
        assert.deepEqual([...assets.keys()].sort(), ["index.html", "app.css", ...scripts.map((name) => `js/${name}`)].map((name) => path.join(root, name)).sort());
        for (const [absolute, content] of assets) assert.deepEqual(content, fs.readFileSync(absolute), absolute);
    });

    it("follows folders inside js/", async () => {
        const folder = publicFolder({ "index.html": "<p></p>", "app.css": "a{}", "js/app.js": "export {}", "js/deep/er/more.js": "export {}", "notes.txt": "not served" });
        const assets = await loadPublicAssets(folder);
        assert.deepEqual([...assets.keys()].map((absolute) => path.relative(folder, absolute)).sort(), ["app.css", "index.html", "js/app.js", "js/deep/er/more.js"]);
    });

    it("fails when a part of the panel is missing", async () => {
        await assert.rejects(loadPublicAssets(publicFolder({ "index.html": "x", "js/app.js": "x" })), { code: "ENOENT" });
        await assert.rejects(loadPublicAssets(publicFolder({ "index.html": "x", "app.css": "x" })), { code: "ENOENT" });
        await assert.rejects(loadPublicAssets(path.join(os.tmpdir(), "jira-canvas-does-not-exist")), { code: "ENOENT" });
    });
});

describe("isApiRequest", () => {
    it("knows the endpoints of the API, with their verbs", () => {
        const yes = [
            ["GET", "/api/state"],
            ["GET", "/api/sites"],
            ["GET", "/api/spaces"],
            ["GET", "/api/spaces/KAN/summary"],
            ["GET", "/api/spaces/KAN/issues"],
            ["GET", "/api/spaces/KAN/versions"],
            ["GET", "/api/spaces/KAN/components"],
            ["GET", "/api/spaces/KAN/boards"],
            ["GET", "/api/boards"],
            ["GET", "/api/boards/1"],
            ["GET", "/api/issues/KAN-1"],
            ["GET", "/api/issues/KAN-1/comments"],
            ["POST", "/api/issues/KAN-1/session"],
            ["GET", "/api/targets"],
            ["GET", "/api/confluence/spaces"],
            ["GET", "/api/confluence/spaces/ENG/pages"],
            ["GET", "/api/confluence/pages/20001"],
            ["GET", "/api/confluence/search"],
            ["PUT", "/api/view"],
            ["POST", "/api/refresh"],
            ["GET", "/api/diagnose"],
        ];
        for (const [method, pathname] of yes) assert.equal(isApiRequest(method, pathname), true, `${method} ${pathname}`);
    });

    it("refuses what is not an endpoint", () => {
        const no = [
            ["POST", "/api/state"],
            ["GET", "/api/issues/KAN-1/session"],
            ["DELETE", "/api/issues/KAN-1"],
            ["GET", "/api/refresh"],
            ["GET", "/api/view"],
            ["PATCH", "/api/view"],
            ["GET", "/api/nope"],
            ["GET", "/api/spaces/KAN/issues/extra"],
            ["GET", "/api/spaces//summary"],
            ["GET", "/api/issues/"],
            ["GET", "/api/issues/KAN-1/comments/1"],
            ["GET", "/events"],
            ["GET", "/"],
            ["GET", "/js/app.js"],
            ["GET", "//api/state"],
            ["GET", "https://evil.example/api/state"],
            ["GET", "/api/state/"],
            ["get", "/api/state"],
        ];
        for (const [method, pathname] of no) assert.equal(isApiRequest(method, pathname), false, `${method} ${pathname}`);
    });
});

describe("serving the panel", () => {
    it("tells where it is and how to get in", async () => {
        const { server } = await start();
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}$/);
        assert.equal(server.url, `http://127.0.0.1:${server.port}/?k=${server.token}`);
        const other = await start();
        assert.notEqual(other.server.token, server.token, "every panel has a token of its own");
        assert.notEqual(other.server.port, server.port);
    });

    it("serves the page with a strict content security policy", async () => {
        const { server } = await start();
        for (const target of ["/", "/index.html"]) {
            const response = await raw(server, { target });
            assert.equal(response.status, 200);
            assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
            assert.equal(response.text, fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8"));
            assert.equal(response.headers["x-content-type-options"], "nosniff");
            assert.equal(response.headers["cache-control"], "no-store");
            assert.equal(response.headers["referrer-policy"], "no-referrer");
            const policy = Object.fromEntries(response.headers["content-security-policy"].split(";").map((directive) => directive.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
            assert.deepEqual(
                { ...policy },
                { "default-src": "'none'", "script-src": "'self'", "style-src": "'self' 'unsafe-inline'", "img-src": "https: data:", "font-src": "'self'", "connect-src": "'self'", "object-src": "'none'", "frame-src": "'none'", "base-uri": "'none'", "form-action": "'none'" },
            );
        }
    });

    it("serves the style sheet and the scripts", async () => {
        const { server } = await start();
        const css = await raw(server, { target: "/app.css" });
        assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
        assert.equal(css.text, fs.readFileSync(path.join(PUBLIC_DIR, "app.css"), "utf8"));
        assert.equal(css.headers["access-control-allow-origin"], "*");
        for (const name of fs.readdirSync(path.join(PUBLIC_DIR, "js"))) {
            const script = await raw(server, { target: `/js/${name}` });
            assert.equal(script.status, 200, name);
            assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8", name);
            assert.equal(script.text, fs.readFileSync(path.join(PUBLIC_DIR, "js", name), "utf8"), name);
            assert.equal(script.headers["content-security-policy"], undefined, "only the page carries the policy");
        }
    });

    it("answers a HEAD request with the headers only", async () => {
        const { server } = await start();
        const response = await raw(server, { method: "HEAD", target: "/app.css" });
        assert.equal(response.status, 200);
        assert.equal(response.text, "");
        assert.equal(Number(response.headers["content-length"]), fs.statSync(path.join(PUBLIC_DIR, "app.css")).size);
    });

    it("does not serve what it does not have", async () => {
        const { server } = await start();
        for (const target of ["/nope", "/js/nope.js", "/js/", "/favicon.ico", "/server.mjs", "/package.json", "/api", "/events/", "/js"]) failure(await raw(server, { target }), 404, "not_found");
    });

    it("cannot be made to read a file outside of its public folder", async () => {
        const { server } = await start();
        const attempts = ["/js/../../server.mjs", "/js/%2e%2e/%2e%2e/server.mjs", "/js/..%2F..%2Fserver.mjs", "/js/%2e%2e%2fserver.mjs", "/js/..%5C..%5Cserver.mjs", "/js//etc/passwd", "/js/%00.js", "/js/./../../extension.mjs"];
        for (const target of attempts) {
            const response = await raw(server, { target });
            assert.equal(response.status, 404, target);
            assert.doesNotMatch(response.text, /export |import /, target);
        }
    });

    it("only reads", async () => {
        const { server } = await start();
        for (const [method, target] of [["POST", "/"], ["PUT", "/app.css"], ["DELETE", "/js/app.js"], ["PATCH", "/index.html"]]) failure(await raw(server, { method, target, headers: { "x-canvas-token": server.token } }), 405, "method_not_allowed");
    });

    it("serves the files it loaded, even when the folder changes afterwards", async () => {
        const folder = publicFolder({ "index.html": "<p>one</p>", "app.css": "a{}", "js/app.js": "export const one = 1;" });
        const { server } = await start({ publicDir: folder });
        fs.writeFileSync(path.join(folder, "index.html"), "<p>two</p>");
        fs.writeFileSync(path.join(folder, "js", "added.js"), "export {}");
        assert.equal((await raw(server, { target: "/" })).text, "<p>one</p>");
        assert.equal((await raw(server, { target: "/js/app.js" })).text, "export const one = 1;");
        failure(await raw(server, { target: "/js/added.js" }), 404, "not_found");
    });

    it("takes the files it is given instead of reading the folder", async () => {
        const folder = publicFolder({ "index.html": "<p>disk</p>", "app.css": "a{}", "js/app.js": "x" });
        const assets = new Map([[path.join(path.resolve(folder), "index.html"), Buffer.from("<p>memory</p>")]]);
        const { server } = await start({ publicDir: folder, assets });
        assert.equal((await raw(server, { target: "/" })).text, "<p>memory</p>");
        failure(await raw(server, { target: "/app.css" }), 404, "not_found");
    });

    it("does not start when the public folder cannot be read", async () => {
        await assert.rejects(startServer({ publicDir: path.join(os.tmpdir(), "jira-canvas-does-not-exist"), workbench: stub() }), { code: "ENOENT" });
    });
});

describe("who may talk to it", () => {
    it("only answers to a loopback host name, so that a rebound DNS name cannot reach it", async () => {
        const { server } = await start();
        for (const host of ["evil.example", "evil.example:80", "127.0.0.1.evil.example", "localhost.evil.example", "192.168.1.20", "[::2]", "0.0.0.0", "localhost@evil.example"]) {
            failure(await raw(server, { target: "/", headers: { host } }), 403, "forbidden", /host/i);
            failure(await api(server, "/api/state", { headers: { host } }), 403, "forbidden", /host/i);
        }
        const bare = await raw(server, { target: "/", setHost: false });
        assert.equal(bare.status, 400, "Node itself turns away an HTTP/1.1 request without a Host header");
        assert.doesNotMatch(bare.text, /<html/i);
        for (const host of ["localhost", "LOCALHOST:5173", "127.0.0.1", `127.0.0.1:${server.port}`, "[::1]", "[::1]:8080"]) assert.equal((await raw(server, { target: "/", headers: { host } })).status, 200, host);
    });

    it("turns away a request that names no host at all", async () => {
        const { server } = await start();
        const withoutHost = await rawSocket(server, "GET / HTTP/1.0\r\n\r\n");
        assert.match(withoutHost, /^HTTP\/1\.1 403 /);
        assert.match(withoutHost, /"code":"forbidden"/);
        assert.doesNotMatch(withoutHost, /<html/i);
        const withHost = await rawSocket(server, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
        assert.match(withHost, /^HTTP\/1\.1 200 /);
    });

    it("wants the token for everything under /api/", async () => {
        const { server } = await start();
        failure(await raw(server, { target: "/api/state" }), 401, "unauthorized", /token/);
        failure(await api(server, "/api/state", { token: "" }), 401, "unauthorized");
        failure(await api(server, "/api/state", { token: "0".repeat(32) }), 401, "unauthorized");
        failure(await api(server, "/api/state", { token: `${server.token}0` }), 401, "unauthorized");
        failure(await api(server, "/api/state", { token: server.token.slice(1) }), 401, "unauthorized");
        failure(await api(server, "/api/state", { token: server.token.toUpperCase() }), 401, "unauthorized");
        failure(await raw(server, { target: `/api/state?k=${server.token}` }), 401, "unauthorized", /token/);
        failure(await raw(server, { target: "/api/nope" }), 401, "unauthorized", /token/);
        failure(await raw(server, { target: "/api/refresh", method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 401, "unauthorized");
        assert.equal((await api(server, "/api/state")).status, 200);
    });

    it("lets a page of the loopback or a page without an origin in, and nobody else", async () => {
        const { server } = await start();
        for (const origin of ["https://evil.example", "http://evil.example", "http://127.0.0.1.evil.example", "http://localhost.evil.example:3000", "https://localhost", "https://127.0.0.1:1", "file:///tmp/x.html", "vscode-webview://abc", "not a url", "", "http://", "evil.example"]) failure(await api(server, "/api/state", { headers: { origin } }), 403, "forbidden", /origin/i);
        for (const origin of ["null", "http://localhost:3000", "http://127.0.0.1:1", "http://LOCALHOST", "http://[::1]:8080"]) assert.equal((await api(server, "/api/state", { headers: { origin } })).status, 200, origin);
    });

    it("checks where a request comes from before it looks at the token", async () => {
        const { server } = await start();
        failure(await raw(server, { target: "/api/state", headers: { origin: "https://evil.example" } }), 403, "forbidden");
        failure(await raw(server, { target: "/api/state", headers: { origin: "http://localhost:1" } }), 401, "unauthorized");
    });

    it("answers a preflight without a token, but only for a page it would let in", async () => {
        const { server } = await start();
        const response = await raw(server, { method: "OPTIONS", target: "/api/refresh", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
        assert.equal(response.status, 204);
        assert.equal(response.text, "");
        assert.equal(response.headers["access-control-allow-origin"], "*");
        assert.equal(response.headers["access-control-allow-headers"], "content-type, x-canvas-token");
        assert.equal(response.headers["access-control-allow-methods"], "GET, POST, PUT, OPTIONS");
        failure(await raw(server, { method: "OPTIONS", target: "/api/refresh", headers: { origin: "https://evil.example" } }), 403, "forbidden");
        failure(await raw(server, { method: "OPTIONS", target: "/api/refresh", headers: { origin: "http://localhost:5173", host: "evil.example" } }), 403, "forbidden");
    });

    it("does not let the browser cache what it answers", async () => {
        const { server } = await start();
        const response = await api(server, "/api/state");
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
        assert.equal(response.headers["access-control-allow-origin"], "*");
    });
});

describe("the API", () => {
    it("describes the panel", async () => {
        const { server } = await start();
        assert.deepEqual(data(await api(server, "/api/state")), {
            instanceId: "srv-1",
            host: "Test",
            view: { ...DEFAULT_VIEW },
            capabilities: { openSession: true },
            intents: [
                { id: "context", label: "Give the session this work item as context" },
                { id: "plan", label: "Investigate it and propose a plan" },
                { id: "implement", label: "Implement it" },
            ],
        });
    });

    it("answers what the panel asks about Jira", async () => {
        const { server } = await start();
        const get = async (target) => data(await api(server, target));
        assert.equal((await get("/api/sites")).sites[0].name, "acme");
        assert.deepEqual((await get("/api/spaces")).spaces.map((space) => space.key), ["KAN", "SAM1"]);
        assert.equal((await get("/api/spaces/KAN/summary")).counts.total, 13);
        assert.deepEqual((await get("/api/spaces/KAN/versions")).items.map((version) => version.name), ["2.0", "1.0"]);
        assert.deepEqual((await get("/api/spaces/KAN/components")).items.map((component) => component.name), ["Backend"]);
        assert.deepEqual((await get("/api/spaces/KAN/boards")).boards.map((board) => board.id), [1, 2], "the boards of the space come first, then those that only mention it");
        assert.deepEqual((await get("/api/boards")).boards.map((board) => board.id).sort(), [1, 2]);
        const board = await get("/api/boards/1");
        assert.deepEqual([board.board.name, board.backlog, board.columns.map((column) => column.name)], ["KAN board", false, ["To Do", "In Progress", "Done"]]);
        assert.equal((await get("/api/boards/1?backlog=1")).backlog, true);
        const issue = await get("/api/issues/KAN-2");
        assert.deepEqual([issue.key, issue.status.name, issue.comments.total], ["KAN-2", "In Progress", 3]);
        assert.deepEqual((await get("/api/issues/KAN-2/comments?start=1")).items.map((comment) => comment.body), ["b", "c"]);
        assert.equal((await get("/api/diagnose")).server, "atlassian");
    });

    it("answers what the panel asks about Confluence", async () => {
        const { server } = await start();
        const get = async (target) => data(await api(server, target));
        assert.deepEqual((await get("/api/confluence/spaces")).items.map((space) => space.key), ["DOCS", "ENG"], "sorted by name");
        assert.deepEqual((await get("/api/confluence/spaces/ENG/pages")).items.map((page) => page.id), ["20001", "20002", "20003"]);
        assert.equal((await get("/api/confluence/pages/20001")).title, "Runbook");
        assert.ok((await get("/api/confluence/search?q=runbook")).items.length >= 1);
    });

    it("reads the filters from the query string", async () => {
        const { server } = await start();
        const page = data(await api(server, "/api/spaces/KAN/issues?status=open&sort=created&limit=5"));
        assert.equal(page.jql, 'project = "KAN" AND statusCategory != 3 ORDER BY created DESC');
        assert.equal(page.items.length, 5);
        assert.ok(page.nextCursor);
        const next = data(await api(server, `/api/spaces/KAN/issues?status=open&sort=created&limit=5&cursor=${encodeURIComponent(page.nextCursor)}`));
        assert.equal(next.items.length, 5);
        assert.ok(!next.items.some((item) => page.items.some((seen) => seen.key === item.key)), "the second page continues after the first");
    });

    it("lets the path decide which space, not the query", async () => {
        const { server } = await start();
        const page = data(await api(server, "/api/spaces/KAN/issues?space=SAM1"));
        assert.match(page.jql, /^project = "KAN"/);
        const issue = data(await api(server, "/api/issues/KAN-2?key=KAN-1"));
        assert.equal(issue.key, "KAN-2");
    });

    it("decodes the parts of the path", async () => {
        const { server } = await start();
        assert.equal(data(await api(server, "/api/issues/KAN%2D2")).key, "KAN-2");
        failure(await api(server, "/api/issues/%E0%A4%A"), 400, "invalid", /path is not valid/);
        failure(await api(server, "/api/issues/KAN-2%2Fcomments"), 400, "invalid", /issue key/);
        failure(await api(server, "/api/issues/KAN-2%3Fx%3D1"), 400, "invalid", /issue key/);
        failure(await api(server, "/api/spaces/KAN%20OR%20x/summary"), 400, "invalid");
    });

    it("never lets a request ask for the latest comments in the way code does", async () => {
        const { server, mock: atlassianMock } = await start();
        atlassianMock.data.comments["KAN-2"] = manyComments(45);
        for (const query of ["", "?newestComments=true", "?newestComments=1", "?newestComments=%74rue"]) {
            const issue = data(await api(server, `/api/issues/KAN-2${query}`));
            assert.deepEqual([issue.comments.items[0].body, issue.comments.items.at(-1).body], ["c1", "c30"], query);
        }
    });

    it("turns what Atlassian says into an HTTP status", async () => {
        const { server, mock: atlassianMock } = await start();
        failure(await api(server, "/api/spaces/ZZZ/summary"), 404, "not_found");
        failure(await api(server, "/api/issues/KAN-999"), 404, "not_found");
        failure(await api(server, "/api/issues/nope"), 400, "invalid", /issue key/);
        failure(await api(server, "/api/boards/abc"), 400, "invalid");
        atlassianMock.failWith("getJiraIssue", { statusCode: 429, message: "Slow down" });
        failure(await api(server, "/api/issues/KAN-1"), 429, "rate_limited");
        atlassianMock.failWith("getJiraIssue", { statusCode: 401, message: "Unauthorized" });
        failure(await api(server, "/api/issues/KAN-2"), 403, "auth");
        atlassianMock.failWith("getJiraIssue", { statusCode: 500, message: "Boom" });
        failure(await api(server, "/api/issues/KAN-3"), 502, "upstream");
    });

    it("says so when the Atlassian server is not connected", async () => {
        const atlassian = createAtlassian({ transport: { tools: async () => [], invoke: async () => assert.fail("nothing to call") } });
        const { server } = await start({ workbench: createWorkbench({ instanceId: "srv-lonely", atlassian, launcher: null }) });
        failure(await api(server, "/api/spaces"), 503, "not_connected", /Atlassian MCP server/);
        assert.equal((await api(server, "/api/spaces")).json.error.message, NOT_CONNECTED);
        assert.equal(data(await api(server, "/api/state")).capabilities.openSession, false, "the panel itself still opens");
    });

    it("clears the cache on request", async () => {
        const { server, mock: atlassianMock } = await start();
        data(await api(server, "/api/spaces"));
        data(await api(server, "/api/spaces"));
        const before = atlassianMock.calls.length;
        assert.deepEqual(data(await send(server, "POST", "/api/refresh")), { refreshed: true });
        data(await api(server, "/api/spaces"));
        assert.ok(atlassianMock.calls.length > before, "the next read goes to Atlassian again");
    });

    it("tells an unknown path from a wrong verb", async () => {
        const { server } = await start();
        failure(await api(server, "/api/nope"), 404, "not_found", /Unknown endpoint/);
        failure(await api(server, "/api/spaces/KAN/nope"), 404, "not_found");
        failure(await send(server, "POST", "/api/state", {}), 405, "method_not_allowed");
        failure(await api(server, "/api/state", { method: "DELETE" }), 405, "method_not_allowed");
        failure(await api(server, "/api/refresh"), 405, "method_not_allowed");
        failure(await api(server, "/api/issues/KAN-2/session"), 405, "method_not_allowed");
        failure(await send(server, "PUT", "/api/issues/KAN-2", {}), 405, "method_not_allowed");
    });

    it("checks that a body is a JSON object", async () => {
        const { server } = await start();
        const post = (headers, body) => api(server, "/api/refresh", { method: "POST", headers, body });
        failure(await post({}, "{}"), 415, "unsupported_media_type");
        failure(await post({ "content-type": "text/plain" }, "{}"), 415, "unsupported_media_type");
        failure(await post({ "content-type": "application/x-www-form-urlencoded" }, "a=1"), 415, "unsupported_media_type");
        failure(await post({ "content-type": "application/json" }, "{bad"), 400, "invalid", /not valid JSON/);
        for (const body of ["[]", "[1]", '"text"', "5", "null", "true"]) failure(await post({ "content-type": "application/json" }, body), 400, "invalid", /must be a JSON object/);
        assert.equal((await post({ "content-type": "application/json" }, undefined)).status, 200, "no body is an empty object");
        assert.equal((await post({ "content-type": "application/json" }, "{}")).status, 200);
        assert.equal((await post({ "content-type": "Application/JSON; charset=utf-8" }, "{}")).status, 200);
    });

    it("refuses a body of more than 1 MiB, and takes one of exactly 1 MiB", async () => {
        const { server } = await start();
        const json = (bytes) => `{"pad":"${"x".repeat(bytes - 10)}"}`;
        assert.equal(Buffer.byteLength(json(MIB)), MIB);
        const exact = await send(server, "POST", "/api/refresh", undefined, { body: json(MIB) });
        assert.equal(exact.status, 200, exact.text.slice(0, 200));
        failure(await send(server, "POST", "/api/refresh", undefined, { body: json(MIB + 1) }), 413, "too_large", /too large/);
    });
});

describe("starting a session", () => {
    it("starts it from the work item of the path, with what the body says", async () => {
        const { server, launcher } = await start();
        const result = data(await send(server, "POST", "/api/issues/KAN-2/session", { target: "same", intent: "plan", notes: "Start with the tests." }));
        assert.deepEqual(result, { sessionId: "session-1", navigated: true, target: "same", name: "KAN-2: Task 2", key: "KAN-2", intent: "plan" });
        assert.equal(launcher.launches.length, 1);
        assert.deepEqual([launcher.launches[0].target, launcher.launches[0].mode, launcher.launches[0].name], ["same", "plan", "KAN-2: Task 2"]);
        assert.match(launcher.launches[0].prompt, /Notes from me:\nStart with the tests\./);
        assert.match(launcher.launches[0].prompt, /Jira work item KAN-2 on acme/);
    });

    it("cannot be pointed at another work item by the body", async () => {
        const { server, launcher } = await start();
        const result = data(await send(server, "POST", "/api/issues/KAN-2/session", { target: "chat", key: "KAN-1" }));
        assert.equal(result.key, "KAN-2");
        assert.match(launcher.launches[0].prompt, /Jira work item KAN-2 /);
    });

    it("remembers where the last session went", async () => {
        const { server } = await start();
        assert.equal(data(await api(server, "/api/targets")).last, "");
        data(await send(server, "POST", "/api/issues/KAN-2/session", { target: "chat" }));
        const { targets, last } = data(await api(server, "/api/targets"));
        assert.deepEqual([targets.map((target) => target.id), last], [["same", "chat"], "chat"]);
    });

    it("refuses what makes no sense, before it starts anything", async () => {
        const { server, launcher } = await start();
        failure(await send(server, "POST", "/api/issues/nope/session", { target: "same" }), 400, "invalid", /issue key/);
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: "same", intent: "autopilot" }), 400, "invalid", /intent must be one of/);
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: "" }), 400, "invalid", /where/);
        failure(await send(server, "POST", "/api/issues/KAN-2/session", {}), 400, "invalid", /where/);
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: ["same"] }), 400, "invalid", /where/);
        failure(await send(server, "POST", "/api/issues/KAN-999/session", { target: "same" }), 404, "not_found");
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: "elsewhere" }), 400, "invalid", /where/);
        assert.deepEqual(launcher.launches.map((launch) => launch.target), ["elsewhere"], "only a launcher can tell which places exist");
    });

    it("says so when the host cannot start sessions", async () => {
        const { server } = await start({ launcher: null });
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: "same" }), 501, "unsupported", /cannot start sessions/);
        failure(await api(server, "/api/targets"), 501, "unsupported", /cannot start sessions/);
    });

    it("passes on the error of the launcher", async () => {
        const { server } = await start({ launcher: fakeLauncher({ launch: async () => Promise.reject(new AtlassianError("upstream", "The project is archived.")) }) });
        failure(await send(server, "POST", "/api/issues/KAN-2/session", { target: "same" }), 502, "upstream", /archived/);
    });
});

describe("the view", () => {
    it("changes it for the panel without sending the change back to that panel", async () => {
        const { server, workbench } = await start();
        const stream = await openStream(server);
        await stream.waitFor(eventNamed("hello"));
        const view = data(await send(server, "PUT", "/api/view", { space: "KAN", tab: "board", board: "1" }));
        assert.deepEqual([view.space, view.tab, view.board], ["KAN", "board", "1"]);
        assert.deepEqual([workbench.getView().space, workbench.getView().tab], ["KAN", "board"]);
        await settle(stream, workbench);
        assert.equal(stream.frames.some(eventNamed("view")), false);
        assert.equal(data(await api(server, "/api/state")).view.tab, "board");
    });

    it("refuses a value that does not make sense", async () => {
        const { server, workbench } = await start();
        failure(await send(server, "PUT", "/api/view", { tab: "nope" }), 400, "invalid");
        failure(await send(server, "PUT", "/api/view", { space: "no way" }), 400, "invalid");
        assert.equal(workbench.getView().tab, "summary");
    });

    it("hands the stub the body and says not to broadcast", async () => {
        const calls = [];
        const { server } = await start({ workbench: stub({ setView: (...args) => (calls.push(args), { ok: true }) }) });
        assert.deepEqual(data(await send(server, "PUT", "/api/view", { tab: "issues" })), { ok: true });
        assert.deepEqual(calls, [[{ tab: "issues" }, { broadcast: false }]]);
    });
});

describe("live events", () => {
    it("wants the token, in the query or in the header", async () => {
        const { server } = await start();
        failure(await raw(server, { target: "/events" }), 401, "unauthorized");
        failure(await raw(server, { target: "/events?k=wrong" }), 401, "unauthorized");
        failure(await raw(server, { target: `/events?k=${server.token}`, headers: { origin: "https://evil.example" } }), 403, "forbidden");
        failure(await raw(server, { target: `/events?k=${server.token}`, headers: { host: "evil.example" } }), 403, "forbidden");
        failure(await raw(server, { target: `/events?k=${server.token}`, method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 405, "method_not_allowed");
        const byQuery = await openStream(server);
        const byHeader = await openStream(server, { target: "/events", headers: { "x-canvas-token": server.token } });
        for (const stream of [byQuery, byHeader]) {
            assert.equal(stream.status, 200);
            await stream.waitFor(eventNamed("hello"));
        }
    });

    it("greets with a retry delay and the panel it belongs to", async () => {
        const { server } = await start();
        const stream = await openStream(server);
        const hello = await stream.waitFor(eventNamed("hello"));
        assert.deepEqual(hello.data, { instanceId: "srv-1" });
        assert.equal(stream.headers["content-type"], "text/event-stream");
        assert.equal(stream.headers["cache-control"], "no-store");
        assert.equal(stream.frames[0].retry, 3000);
    });

    it("tells the panel what the agent changed", async () => {
        const { server, workbench } = await start();
        const stream = await openStream(server);
        await stream.waitFor(eventNamed("hello"));
        workbench.setView({ space: "KAN", tab: "board" });
        const view = await stream.waitFor(eventNamed("view"));
        assert.deepEqual(view.data.changed, ["space", "tab"]);
        assert.deepEqual([view.data.view.space, view.data.view.tab], ["KAN", "board"]);
        workbench.refresh();
        assert.deepEqual((await stream.waitFor(eventNamed("changed"))).data, { reason: "refresh" });
    });

    it("sends to every panel that is listening, and to none that has gone", async () => {
        const { server, workbench } = await start();
        const first = await openStream(server);
        const second = await openStream(server);
        await Promise.all([first, second].map((stream) => stream.waitFor(eventNamed("hello"))));
        first.close();
        await first.ended;
        workbench.emit("changed", { reason: "one" });
        await second.waitFor((frame) => frame.event === "changed" && frame.data.reason === "one");
        assert.equal(first.frames.some((frame) => frame.event === "changed"), false);
    });

    it("keeps eight listeners and lets the oldest go when a ninth comes", async () => {
        const { server, workbench } = await start();
        const listeners = [];
        for (let index = 0; index < 9; index++) {
            const stream = await openStream(server);
            await stream.waitFor(eventNamed("hello"));
            listeners.push(stream);
        }
        await listeners[0].ended;
        assert.equal(listeners[0].finished, true);
        assert.ok(listeners.slice(1).every((stream) => !stream.finished));
        workbench.emit("changed", { reason: "all" });
        await Promise.all(listeners.slice(1).map((stream) => stream.waitFor((frame) => frame.event === "changed")));
        assert.equal(listeners[0].frames.some((frame) => frame.event === "changed"), false);
    });

    it("pings now and then so that the connection is not taken for dead", async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const { server } = await start();
        const stream = await openStream(server);
        await stream.waitFor(eventNamed("hello"));
        t.mock.timers.tick(24_999);
        assert.equal(stream.frames.some((frame) => frame.comment === "ping"), false);
        t.mock.timers.tick(1);
        await stream.waitFor((frame) => frame.comment === "ping");
        t.mock.timers.tick(25_000);
        await stream.waitFor((frame) => frame.comment === "ping" && frame !== stream.frames.find((other) => other.comment === "ping"));
        await server.close();
    });

    it("ends the streams when the server closes, and stops listening", async () => {
        const { server, workbench } = await start();
        const stream = await openStream(server);
        await stream.waitFor(eventNamed("hello"));
        await server.close();
        await stream.ended;
        assert.doesNotThrow(() => workbench.emit("changed", { reason: "late" }));
        await assert.rejects(raw(server, { target: "/" }), { code: "ECONNREFUSED" });
        await server.close();
    });
});

describe("failures", () => {
    it("gives each kind of error its status", async () => {
        const codes = { invalid: 400, auth: 403, forbidden: 403, not_found: 404, not_connected: 503, unsupported: 501, rate_limited: 429, timeout: 504, upstream: 502, "something else": 502 };
        for (const [code, status] of Object.entries(codes)) {
            const { server } = await start({ workbench: stub({ spaces: async () => Promise.reject(new AtlassianError(code, `message of ${code}`)) }) });
            const response = await api(server, "/api/spaces");
            assert.equal(response.status, status, code);
            assert.deepEqual(response.json, { ok: false, error: { code, message: `message of ${code}` } }, code);
        }
    });

    it("keeps what went wrong inside to itself", async () => {
        const logs = [];
        const { server } = await start({
            log: (level, message) => logs.push([level, message]),
            workbench: stub({
                spaces: async () => {
                    throw new TypeError("secret detail about /Users/someone/project");
                },
            }),
        });
        const response = await api(server, "/api/spaces");
        failure(response, 500, "internal", /^Unexpected error in the canvas server\.$/);
        assert.doesNotMatch(response.text, /secret|Users|TypeError/);
        assert.equal(logs.length, 1);
        assert.equal(logs[0][0], "error");
        assert.match(logs[0][1], /Unexpected error in the canvas server: TypeError: secret detail/);
        assert.equal((await api(server, "/api/state")).status, 200, "the server carries on");
    });

    it("also catches a workbench that cannot start", async () => {
        const { server } = await start({ workbench: stub({ init: async () => Promise.reject(new AtlassianError("upstream", "no luck")) }) });
        failure(await api(server, "/api/state"), 502, "upstream", /no luck/);
    });

    it("does not load the workbench for a request that is refused", async () => {
        let started = 0;
        const { server } = await start({ workbench: stub({ init: async () => void started++ }) });
        failure(await raw(server, { target: "/api/state" }), 401, "unauthorized");
        failure(await api(server, "/api/nope"), 404, "not_found");
        failure(await send(server, "POST", "/api/state", {}), 405, "method_not_allowed");
        failure(await api(server, "/api/refresh", { method: "POST", body: "{}" }), 415, "unsupported_media_type");
        assert.equal(started, 0);
        data(await api(server, "/api/state"));
        assert.equal(started, 1);
    });
});
