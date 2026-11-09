// One workbench per open canvas panel: the view state shared by the UI and the agent, plus the data and actions both use.

import { AtlassianError, patterns } from "./atlassian.mjs";
import { INTENTS, buildIssueSession } from "./session-launch.mjs";

const { KEY_RE, SPACE_RE } = patterns;

export const TABS = Object.freeze(["summary", "board", "backlog", "issues", "releases", "components", "pages"]);
export const STATUSES = Object.freeze(["all", "open", "todo", "inprogress", "done"]);
export const SORTS = Object.freeze(["updated", "created", "priority", "due"]);
export const DOMAINS = Object.freeze(["jira", "confluence"]);
export const QUERY_MODES = Object.freeze(["text", "jql"]);

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

// Filters that belong to a space and start over when another space is opened.
const SPACE_SCOPED = Object.freeze({ board: "", q: "", qMode: "text", status: "all", assignee: "any", type: "", sort: "updated", issue: "", page: "" });

const invalid = (message) => new AtlassianError("invalid", message);
const oneOf = (list) => (value, name) => {
    if (!list.includes(value)) throw invalid(`${name} must be one of: ${list.join(", ")}.`);
    return value;
};
const text = (max) => (value, name) => {
    if (typeof value !== "string") throw invalid(`${name} must be text.`);
    if (value.length > max) throw invalid(`${name} is limited to ${max} characters.`);
    return value;
};
const digits = (max) => (value, name) => {
    const raw = typeof value === "number" ? String(value) : value;
    if (typeof raw !== "string" || (raw !== "" && !new RegExp(`^\\d{1,${max}}$`).test(raw))) throw invalid(`${name} must be a number.`);
    return raw;
};

const RULES = {
    domain: oneOf(DOMAINS),
    site: text(200),
    space: (value, name) => {
        const raw = text(40)(value, name).trim();
        if (raw && !SPACE_RE.test(raw)) throw invalid(`${name} must be a Jira space key such as KAN.`);
        return raw.toUpperCase();
    },
    tab: oneOf(TABS),
    board: digits(12),
    q: text(500),
    qMode: oneOf(QUERY_MODES),
    status: oneOf(STATUSES),
    assignee: (value, name) => {
        const raw = text(80)(value, name);
        if (!["any", "me", "unassigned"].includes(raw) && !/^[0-9a-f]{1,8}:[0-9a-f-]{20,}$|^[0-9a-f]{24}$/i.test(raw)) throw invalid(`${name} must be any, me, unassigned or an account id.`);
        return raw;
    },
    type: text(80),
    sort: oneOf(SORTS),
    issue: (value, name) => {
        const raw = text(40)(value, name).trim();
        if (raw && !KEY_RE.test(raw)) throw invalid(`${name} must be an issue key such as KAN-12.`);
        return raw.toUpperCase();
    },
    cspace: (value, name) => {
        const raw = text(80)(value, name).trim();
        if (raw && !/^[A-Za-z0-9_~.-]+$/.test(raw)) throw invalid(`${name} must be a Confluence space key.`);
        return raw;
    },
    cq: text(200),
    page: digits(20),
};

/** Validates a partial view and merges it into the current one. Throws an `invalid` error for anything unexpected. */
export function mergeView(current, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("The view must be an object.");
    const next = {};
    for (const [name, value] of Object.entries(patch)) {
        if (!Object.hasOwn(RULES, name)) throw invalid(`Unknown view field "${name}".`);
        next[name] = value === null || value === undefined ? DEFAULT_VIEW[name] : RULES[name](value, name);
    }
    const base = "space" in next && next.space !== current.space ? { ...current, ...SPACE_SCOPED } : current;
    return { ...base, ...next };
}

function inputPatch(input) {
    const patch = {};
    for (const name of ["site", "space", "issue", "tab"]) if (typeof input?.[name] === "string" && input[name].trim()) patch[name] = input[name].trim();
    if (patch.issue && !patch.space) patch.space = patch.issue.split("-")[0];
    if (patch.issue && !patch.tab) patch.tab = "issues";
    return patch;
}

const initialView = (input) => mergeView({ ...DEFAULT_VIEW }, inputPatch(input));

const registry = new Set();

/**
 * @param {object} options
 * @param {string} options.instanceId
 * @param {object} [options.input] Values the canvas was opened with: site, space, issue, tab.
 * @param {ReturnType<import("./atlassian.mjs").createAtlassian>} options.atlassian
 * @param {{ targets(): Promise<object[]>, launch(request: object): Promise<object> } | null} [options.launcher] Starts a session; absent when the host cannot.
 * @param {string} [options.host] Name of the host shown in the UI.
 */
export function createWorkbench({ instanceId, input = {}, atlassian, launcher = null, host = "Copilot", log = () => {} }) {
    let view = initialView(input);
    let ready = null;
    let closed = false;
    let lastTarget = "";
    const subscribers = new Set();

    const emit = (type, data) => {
        for (const callback of subscribers) {
            try {
                callback(type, data);
            } catch (error) {
                log("warning", `A canvas listener failed: ${error?.message ?? error}`);
            }
        }
    };
    const siteOf = (params) => str(params?.site) || view.site;
    const site = (params) => ({ site: siteOf(params) });

    const workbench = {
        instanceId,
        emit,
        get closed() {
            return closed;
        },

        init() {
            ready ??= Promise.resolve();
            return ready;
        },

        describe() {
            return {
                instanceId,
                host,
                view: { ...view },
                capabilities: { openSession: Boolean(launcher) },
                intents: Object.entries(INTENTS).map(([id, intent]) => ({ id, label: intent.label })),
            };
        },

        subscribe(callback) {
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        },

        getView: () => ({ ...view }),

        /** Applies the input the canvas is opened with (site, space, issue, tab) to a panel that is already open. */
        navigate(input) {
            const patch = inputPatch(input);
            return Object.keys(patch).length ? workbench.setView(patch) : { ...view };
        },
        setView(patch, { broadcast = true } = {}) {
            const next = mergeView(view, patch);
            const changed = Object.keys(next).filter((name) => next[name] !== view[name]);
            view = next;
            if (changed.length && broadcast) emit("view", { view: { ...view }, changed });
            return { ...view };
        },

        // ---- Jira ---------------------------------------------------------------------------------------------------------
        async sites() {
            const list = await atlassian.sites();
            const current = list.find((candidate) => candidate.cloudId === view.site || candidate.url === view.site || candidate.name === view.site) ?? list[0] ?? null;
            return { sites: list, current: current?.cloudId ?? "" };
        },
        spaces: (params) => atlassian.listSpaces(site(params)),
        boards: (params) => atlassian.listBoards({ ...site(params), space: params?.space }),
        board: (params) => atlassian.getBoard({ ...site(params), id: params?.id, backlog: params?.backlog === true || params?.backlog === "1" || params?.backlog === "true", cursor: params?.cursor }),
        summary: (params) => atlassian.spaceSummary({ ...site(params), space: params?.space }),
        issues: (params) => atlassian.searchIssues({ ...site(params), space: params?.space, q: params?.q, qMode: params?.qMode, status: params?.status, assignee: params?.assignee, type: params?.type, sort: params?.sort, cursor: params?.cursor, limit: params?.limit }),
        issue: (params) => atlassian.getIssue({ ...site(params), key: params?.key, newestComments: params?.newestComments === true }),
        comments: (params) => atlassian.listComments({ ...site(params), key: params?.key, start: params?.start }),
        versions: (params) => atlassian.listVersions({ ...site(params), space: params?.space }),
        components: (params) => atlassian.listComponents({ ...site(params), space: params?.space }),

        // ---- Confluence -----------------------------------------------------------------------------------------------------
        confluenceSpaces: (params) => atlassian.listConfluenceSpaces(site(params)),
        confluencePages: (params) => atlassian.listConfluencePages({ ...site(params), space: params?.space, cursor: params?.cursor }),
        confluencePage: (params) => atlassian.getConfluencePage({ ...site(params), id: params?.id }),
        confluenceSearch: (params) => atlassian.searchConfluence({ ...site(params), q: params?.q, cursor: params?.cursor }),

        // ---- sessions -------------------------------------------------------------------------------------------------------
        async targets() {
            if (!launcher) throw new AtlassianError("unsupported", "This host cannot start sessions.");
            return { targets: await launcher.targets(), last: lastTarget };
        },

        async openSession({ key, target, intent = "context", notes = "", site: wanted } = {}) {
            if (!launcher) throw new AtlassianError("unsupported", "This host cannot start sessions.");
            const issueKey = str(key).trim().toUpperCase();
            if (!KEY_RE.test(issueKey)) throw invalid("An issue key looks like KAN-12.");
            if (!Object.hasOwn(INTENTS, intent)) throw invalid(`The intent must be one of: ${Object.keys(INTENTS).join(", ")}.`);
            if (typeof target !== "string" || !target) throw invalid("Choose where the session should start.");
            const wantedSite = siteOf({ site: wanted });
            const [issue, siteInfo] = await Promise.all([atlassian.getIssue({ site: wantedSite, key: issueKey, newestComments: true }), atlassian.siteFor(wantedSite)]);
            const session = buildIssueSession(issue, { site: siteInfo, intent, notes: str(notes) });
            const result = await launcher.launch({ target, ...session });
            lastTarget = result.target ?? target;
            return { ...result, name: session.name, key: issueKey, intent };
        },

        // ---- housekeeping ---------------------------------------------------------------------------------------------------
        refresh() {
            atlassian.clearCache();
            for (const other of registry) other.emit("changed", { reason: "refresh" });
            return { refreshed: true };
        },
        diagnose: (params) => atlassian.diagnose(site(params)),

        close() {
            closed = true;
            subscribers.clear();
            registry.delete(workbench);
        },
    };

    registry.add(workbench);
    return workbench;
}

function str(value) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}
