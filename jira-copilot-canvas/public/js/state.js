// Client-side store and controller. Views read `state` and call the exported actions; every change is announced on a
// topic ("phase", "view", "meta", "status", "refresh", "launch") so each region re-renders only what it needs.
import { api, ApiError, connectEvents, useSite } from "./api.js";
import { toast } from "./dom.js";

const listeners = new Map();

export function on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, data) {
    for (const fn of [...(listeners.get(topic) ?? [])]) {
        try {
            fn(data);
        } catch (error) {
            console.error(`listener for "${topic}" failed`, error);
        }
    }
}

// Mirrors the server's view model (workbench.mjs): the UI applies a change at once and the server validates it.
export const DEFAULT_VIEW = Object.freeze({
    domain: "jira",
    site: "",
    space: "",
    tab: "summary",
    board: "",
    q: "",
    qMode: "text",
    status: "all",
    assignee: "any",
    type: "",
    sort: "updated",
    issue: "",
    cspace: "",
    cq: "",
    page: "",
});
const SPACE_SCOPED = Object.freeze({ board: "", q: "", qMode: "text", status: "all", assignee: "any", type: "", sort: "updated", issue: "", page: "" });
const VIEW_KEYS = Object.keys(DEFAULT_VIEW);

export const state = {
    phase: "boot", // boot | ready | error
    fatal: null,
    host: "Copilot",
    instanceId: null,
    capabilities: { openSession: false },
    intents: [],
    view: { ...DEFAULT_VIEW },
    sites: [],
    currentSite: "",
    live: "connecting", // connecting | live | reconnecting | closed
    syncing: 0,
    knownTypes: new Set(),
    spaceKeys: new Set(),
    spaceNames: new Map(),
    cspaceNames: new Map(),
    boards: new Map(),
    people: new Map(),
    launchFor: "",
    focusDetail: false,
};

export const notifyError = (error) => toast(error?.message ?? String(error), "error", 7000);

// ---- what the app has learned about the site ------------------------------------------------------------------------
export function siteInfo() {
    const wanted = state.view.site || state.currentSite;
    return state.sites.find((site) => site.cloudId === wanted || site.url === wanted || site.name === wanted) ?? state.sites[0] ?? null;
}

export function noteSpaces(spaces) {
    let changed = false;
    for (const space of spaces ?? []) {
        if (!state.spaceKeys.has(space.key)) {
            state.spaceKeys.add(space.key);
            changed = true;
        }
        if (state.spaceNames.get(space.key) !== space.name) {
            state.spaceNames.set(space.key, space.name);
            changed = true;
        }
    }
    if (changed) emit("meta");
}

export function noteConfluenceSpaces(spaces) {
    let changed = false;
    for (const space of spaces ?? []) {
        if (state.cspaceNames.get(space.key) !== space.name) {
            state.cspaceNames.set(space.key, space.name);
            changed = true;
        }
    }
    if (changed) emit("meta");
}

let spacesLoad = null;
/** Learns the site's space keys and names in the background; they label the breadcrumb and decide which keys in text become links. */
export function ensureSpaces() {
    spacesLoad ??= api
        .spaces()
        .then(({ spaces }) => noteSpaces(spaces))
        .catch(() => {})
        .finally(() => {
            spacesLoad = null;
        });
    return spacesLoad;
}

export function noteBoards(boards) {
    let changed = false;
    for (const board of boards ?? []) {
        const known = state.boards.get(String(board.id));
        if (!known || known.name !== board.name || known.url !== board.url) {
            state.boards.set(String(board.id), board);
            changed = true;
        }
    }
    if (changed) emit("meta");
}

/** Remembers issue types and assignees seen so far so the filter menus can offer them. Returns true when something new appeared. */
export function noteIssues(items) {
    let changed = false;
    for (const item of items ?? []) {
        if (item.type?.name && !state.knownTypes.has(item.type.name)) {
            state.knownTypes.add(item.type.name);
            changed = true;
        }
        if (item.assignee?.id && !state.people.has(item.assignee.id)) {
            state.people.set(item.assignee.id, item.assignee.name);
            changed = true;
        }
    }
    return changed;
}

export function noteTypes(names) {
    let changed = false;
    for (const name of names ?? []) {
        if (name && !state.knownTypes.has(name)) {
            state.knownTypes.add(name);
            changed = true;
        }
    }
    return changed;
}

const forgetSpaceData = () => {
    state.knownTypes.clear();
    state.people.clear();
};

/** Work item keys such as KAN-12 become links only for projects the site really has, so "UTF-8" or "SHA-256" stay plain text. */
export function isIssueKey(key, ownSpace = "") {
    const prefix = key.slice(0, key.lastIndexOf("-"));
    return prefix === ownSpace || prefix === state.view.space || state.spaceKeys.has(prefix);
}

export function drawerTarget(view = state.view) {
    if (view.domain === "confluence" || view.tab === "pages") return view.page ? { kind: "page", id: view.page } : null;
    return view.issue ? { kind: "issue", id: view.issue } : null;
}

/** The page of the current view in Jira or Confluence itself. */
export function externalUrl(view = state.view) {
    const base = siteInfo()?.url?.replace(/\/+$/, "");
    if (!base) return "";
    if (view.domain === "confluence") return view.cspace ? `${base}/wiki/spaces/${encodeURIComponent(view.cspace)}` : `${base}/wiki`;
    if (!view.space) return `${base}/jira/projects`;
    const board = view.board ? state.boards.get(view.board) : null;
    if ((view.tab === "board" || view.tab === "backlog") && board) return board.url || `${base}/jira/software/projects/${encodeURIComponent(view.space)}/boards/${board.id}`;
    return `${base}/browse/${encodeURIComponent(view.space)}`;
}

// ---- view -----------------------------------------------------------------------------------------------------------
function merge(current, patch) {
    const next = {};
    for (const [name, value] of Object.entries(patch ?? {})) {
        if (!VIEW_KEYS.includes(name)) continue;
        let v = value === null || value === undefined ? DEFAULT_VIEW[name] : String(value);
        if (name === "space" || name === "issue") v = v.trim().toUpperCase();
        else if (name === "cspace") v = v.trim();
        next[name] = v;
    }
    const base = "space" in next && next.space !== current.space ? { ...current, ...SPACE_SCOPED } : current;
    return { ...base, ...next };
}

const diff = (before, after) => VIEW_KEYS.filter((name) => before[name] !== after[name]);

function applyView(view) {
    const before = state.view;
    const next = { ...DEFAULT_VIEW, ...view };
    const changed = diff(before, next);
    state.view = next;
    useSite(next.site);
    if (changed.includes("space") || changed.includes("site")) forgetSpaceData();
    if (changed.length) emit("view", { changed });
}

let persistChain = Promise.resolve();
let pendingViews = 0;

async function resync() {
    try {
        applyView((await api.state()).view);
    } catch {
        /* the next data request reports the real problem */
    }
}

/** Applies a view change right away, then lets the server validate and store it. Accepts the same partial view as the agent's set_view. */
export function setView(patch) {
    const next = merge(state.view, patch);
    const changed = diff(state.view, next);
    if (!changed.length) return;
    const forget = changed.includes("space") || changed.includes("site");
    state.view = next;
    useSite(next.site);
    if (forget) forgetSpaceData();
    emit("view", { changed });
    pendingViews++;
    persistChain = persistChain
        .then(() => api.setView(patch))
        .catch((error) => {
            notifyError(error);
            return resync();
        })
        .finally(() => {
            pendingViews--;
        });
}

/** Opens the Work items tab with exactly these filters; every other filter goes back to its default. */
export function showWorkItems(filters = {}) {
    setView({ tab: "issues", issue: null, page: null, q: null, qMode: null, status: null, assignee: null, type: null, sort: null, ...filters });
}

export function switchSite(site) {
    for (const map of [state.spaceNames, state.cspaceNames, state.boards]) map.clear();
    state.spaceKeys.clear();
    setView({ site, space: null, tab: "summary", board: null, issue: null, cspace: null, page: null, cq: null });
    ensureSpaces();
}

export function openIssue(key, { fromKeyboard = false } = {}) {
    state.focusDetail = fromKeyboard;
    setView({ issue: key });
}

export function openPage(id, { fromKeyboard = false } = {}) {
    state.focusDetail = fromKeyboard;
    setView({ page: id });
}

/** Opens the work item's drawer with the "New Copilot session" panel already showing. */
export function openLaunch(key) {
    state.launchFor = key;
    state.focusDetail = true;
    if (state.view.issue === key && drawerTarget()?.kind === "issue") emit("launch", { key });
    else setView({ issue: key });
}

export function closeDetail() {
    const target = drawerTarget();
    if (target?.kind === "page") setView({ page: null });
    else if (target?.kind === "issue") setView({ issue: null });
}

/** Shows a request in the toolbar's busy indicator. */
export function track(promise) {
    state.syncing++;
    emit("status");
    const done = () => {
        state.syncing = Math.max(0, state.syncing - 1);
        emit("status");
    };
    promise.then(done, done);
    return promise;
}

// ---- boot and live updates ------------------------------------------------------------------------------------------
function fail(error) {
    state.phase = "error";
    state.fatal = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "error", message: String(error?.message ?? error) };
    emit("phase");
}

async function loadSites() {
    try {
        const { sites, current } = await api.sites();
        state.sites = sites ?? [];
        state.currentSite = current ?? "";
        emit("meta");
    } catch {
        /* the first data request reports why Atlassian is unreachable */
    }
}

let bootPromise = null;
export function boot() {
    bootPromise ??= (async () => {
        state.phase = "boot";
        state.fatal = null;
        emit("phase");
        try {
            const described = await api.state();
            state.instanceId = described.instanceId;
            state.host = described.host || "Copilot";
            state.capabilities = { openSession: Boolean(described.capabilities?.openSession) };
            state.intents = described.intents ?? [];
            applyView(described.view);
            await loadSites();
            state.phase = "ready";
            emit("phase");
            ensureSpaces();
        } catch (error) {
            fail(error);
        } finally {
            bootPromise = null;
        }
    })();
    return bootPromise;
}

let ownRefreshAt = 0;

async function reloadEverything() {
    forgetSpaceData();
    await loadSites();
    emit("refresh");
    ensureSpaces();
}

/** Clears the server cache, then asks every view to reload. */
export async function refreshAll() {
    ownRefreshAt = Date.now();
    try {
        await track(api.refresh());
    } catch (error) {
        notifyError(error);
    }
    await reloadEverything();
}

let helloSeen = false;

function handleEvent(type, data) {
    if (type === "hello") {
        if (helloSeen) resync();
        helloSeen = true;
    } else if (type === "view" && data?.view) {
        if (pendingViews === 0) applyView(data.view);
    } else if (type === "changed") {
        // The server also broadcasts our own refresh back to us; it has been handled already.
        if (Date.now() - ownRefreshAt > 1500) reloadEverything();
    }
}

export function startLive() {
    connectEvents(handleEvent, (status) => {
        state.live = status;
        emit("status");
    });
}
