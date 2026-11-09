// In-memory stand-in for the Atlassian MCP server. It has the tool names and the response shapes of the real one,
// evaluates the JQL that the canvas builds, and records every call so that tests can check what was asked for and that
// nothing was ever written.

export const SERVER = "atlassian";
export const CLOUD_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const SITE_URL = "https://acme.atlassian.net";

/** The only tools, and the only executeRead operations, that the canvas may call. */
export const ALLOWED_TOOLS = Object.freeze(["getAccessibleAtlassianResources", "atlassianUserInfo", "getJiraIssue", "searchJiraIssuesUsingJql", "listJiraIssueComments", "getConfluenceContent", "searchConfluence", "executeRead", "getVisibleJiraProjects", "getConfluenceSpaces"]);
export const ALLOWED_OPERATIONS = Object.freeze(["listJiraProjects", "listJiraBoards", "getJiraBoardConfig", "getJiraBoardIssueData", "getJiraProjectVersions", "listJiraProjectComponents", "listConfluenceSpaces"]);
const WRITE_TOOLS = ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addOrEditJiraIssueComment", "createConfluenceContent", "updateConfluenceContent", "executeWrite", "executeDestructive"];
const OTHER_TOOLS = ["discover", "search", "getJiraProjectVersions"];

export const ALICE = { accountId: "712020:7c3a1e4b-9d3e-4a5b-8c7f-0123456789ab", displayName: "Alice Martin", avatarUrls: { "48x48": "https://avatar.example/alice/48" } };
export const BOB = { accountId: "712020:0b9f6a52-3c1d-4f0e-a2b7-fedcba987654", displayName: "Bob Chen" };

const STATUS = {
    todo: { id: "10000", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
    doing: { id: "10001", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
    done: { id: "10002", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
};
const TYPE = {
    task: { id: "10003", name: "Task", subtask: false, hierarchyLevel: 0 },
    subtask: { id: "10004", name: "Subtask", subtask: true, hierarchyLevel: -1 },
    bug: { id: "10005", name: "Bug", subtask: false, hierarchyLevel: 0 },
};
const RANK = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };

export const adf = (...content) => ({ type: "doc", version: 1, content });
export const paragraph = (...content) => ({ type: "paragraph", content });
export const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) });

function makeIssue(project, n, { summary, status = "todo", type = "task", priority = "Medium", assignee = null, labels = [], due = null, parent = null, description = null }) {
    return {
        project,
        key: `${project}-${n}`,
        id: String((project === "KAN" ? 10000 : 11000) + n),
        description,
        components: [],
        fixVersions: [],
        links: [],
        subtasks: [],
        fields: {
            summary,
            status: STATUS[status],
            issuetype: TYPE[type],
            priority: { name: priority },
            assignee,
            reporter: ALICE,
            labels,
            duedate: due,
            // Issue 1 is the most recently updated and the least recently created, whatever n is.
            created: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
            updated: new Date(Date.UTC(2026, 10, 20) - n * 60_000).toISOString(),
            ...(parent && { parent: { key: parent.key, id: parent.id, fields: { summary: parent.fields.summary, status: parent.fields.status, issuetype: parent.fields.issuetype } } }),
        },
    };
}

const comment = (id, author, body, created) => ({ id: String(id), author, body, created, updated: created });

function fixtures() {
    const issues = [];
    const add = (...args) => {
        const issue = makeIssue(...args);
        issues.push(issue);
        return issue;
    };
    const one = add("KAN", 1, { summary: "Task 1", due: "2020-01-01" });
    const two = add("KAN", 2, { summary: "Task 2", status: "doing", assignee: ALICE, priority: "High", description: adf({ type: "heading", attrs: { level: 2 }, content: [text("Goal")] }, paragraph(text("Ship the "), text("canvas", [{ type: "strong" }]), text(".")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("first"))] }, { type: "listItem", content: [paragraph(text("second"))] }] }) });
    const sub = add("KAN", 3, { summary: "Subtask 2.1", status: "done", type: "subtask", parent: two });
    for (let n = 4; n <= 13; n++) add("KAN", n, { summary: `Dummy issue ${n - 3}`, labels: ["dummy"], due: n === 4 ? "2099-01-01" : null });
    add("SAM1", 1, { summary: "Set a fitness goal", priority: "Low" });
    add("SAM1", 2, { summary: "Log a first workout", status: "doing", assignee: BOB, type: "bug" });
    two.subtasks = [sub];
    two.links = [{ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: one }];
    two.components = [{ name: "Backend" }];
    two.fixVersions = [{ name: "1.0" }];
    return {
        issues,
        projects: [
            { id: "10000", key: "KAN", name: "Product Roadmap", projectTypeKey: "software", style: "next-gen", lead: ALICE },
            { id: "10001", key: "SAM1", name: "(Example) Fitness and Health Goals", projectTypeKey: "software", style: "classic", lead: BOB },
        ],
        boards: [
            { id: 1, name: "KAN board", type: "simple", location: { projectKey: "KAN", projectName: "Product Roadmap" } },
            { id: 2, name: "SAM1 board", type: "simple", location: { projectKey: "SAM1", projectName: "(Example) Fitness and Health Goals" } },
        ],
        boardConfigs: {
            1: { name: "KAN board", type: "simple", location: { key: "KAN", name: "Product Roadmap" }, columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "10000", name: "To Do" }] }, { name: "In Progress", statuses: [{ id: "10001", name: "In Progress" }] }, { name: "Done", statuses: [{ id: "10002", name: "Done" }] }] } },
            2: { name: "SAM1 board", type: "simple", location: { key: "SAM1", name: "(Example) Fitness and Health Goals" } },
        },
        versions: { KAN: [{ id: "20000", name: "1.0", released: true, releaseDate: "2026-10-01", description: "First release" }, { id: "20001", name: "2.0", released: false, releaseDate: "2026-12-01", overdue: false }], SAM1: [] },
        components: { KAN: [{ id: "30000", name: "Backend", description: "Services", lead: ALICE, issueCount: 1 }], SAM1: [] },
        comments: {
            "KAN-1": [comment(1, ALICE, "First *comment*", "2026-11-02T09:00:00.000+0000"), comment(2, BOB, "Second", "2026-11-03T09:00:00.000+0000")],
            "KAN-2": [comment(3, ALICE, "a", "2026-11-04T09:00:00.000+0000"), comment(4, BOB, "b", "2026-11-05T09:00:00.000+0000"), comment(5, ALICE, "c", "2026-11-06T09:00:00.000+0000")],
        },
        confluenceSpaces: [
            { id: "1001", key: "ENG", name: "Engineering", type: "global", status: "current", description: { plain: { value: "Engineering notes" } }, _links: { webui: "/spaces/ENG", base: `${SITE_URL}/wiki` } },
            { id: "1002", key: "DOCS", name: "Documentation", type: "global", status: "current", _links: { webui: "/spaces/DOCS" } },
        ],
        confluencePages: [
            { id: "20001", title: "Runbook", space: { key: "ENG", name: "Engineering" }, when: "2026-11-03T09:00:00.000Z", by: ALICE, body: "# Runbook\n\nRestart the **service**." },
            { id: "20002", title: "Architecture", space: { key: "ENG", name: "Engineering" }, when: "2026-11-02T09:00:00.000Z", by: BOB, body: "Services talk over HTTP." },
            { id: "20003", title: "Onboarding", space: { key: "ENG", name: "Engineering" }, when: "2026-11-01T09:00:00.000Z", by: BOB, body: "Welcome. Read the runbook." },
            { id: "20004", title: "Style guide", space: { key: "DOCS", name: "Documentation" }, when: "2026-10-20T09:00:00.000Z", by: ALICE, body: "Write short sentences." },
        ],
    };
}

// ---- results ------------------------------------------------------------------------------------------------------
const ok = (data, structured = null) => ({ ok: true, text: JSON.stringify({ data }), structured });
const fail = (statusCode, message) => ({ ok: false, text: "", structured: null, error: `MCP server '${SERVER}': ${JSON.stringify({ statusCode, message })}` });
export const okResult = ok;
export const failResult = fail;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- a small JQL evaluator: exactly the clauses the canvas generates ------------------------------------------------
function splitOutside(source, separator) {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
            if (char === "\\") i++;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (depth === 0 && source.startsWith(separator, i)) {
            parts.push(source.slice(start, i));
            start = i + separator.length;
            i = start - 1;
        }
    }
    parts.push(source.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

const unquote = (value) => value.trim().replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");
// True when one pair of parentheses encloses the whole clause.
function wrapped(clause) {
    if (!clause.startsWith("(") || !clause.endsWith(")")) return false;
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < clause.length; i++) {
        const char = clause[i];
        if (quoted) {
            if (char === "\\") i++;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "(") depth++;
        else if (char === ")" && --depth === 0 && i < clause.length - 1) return false;
    }
    return true;
}

function matches(clause, issue) {
    const c = clause.trim();
    const f = issue.fields;
    if (wrapped(c)) {
        const inner = c.slice(1, -1);
        const alternatives = splitOutside(inner, " OR ");
        return alternatives.length > 1 ? alternatives.some((part) => matches(part, issue)) : splitOutside(inner, " AND ").every((part) => matches(part, issue));
    }
    let m;
    if ((m = /^project = (".*")$/.exec(c))) return issue.project === unquote(m[1]);
    if ((m = /^key = (".*")$/.exec(c))) return issue.key === unquote(m[1]);
    if ((m = /^text ~ (".*")$/.exec(c))) return unquote(m[1]).toLowerCase().split(/\s+/).every((word) => `${f.summary} ${issue.description ? JSON.stringify(issue.description) : ""}`.toLowerCase().includes(word));
    if ((m = /^statusCategory (=|!=) (\d)$/.exec(c))) return (f.status.statusCategory.id === Number(m[2])) === (m[1] === "=");
    if (c === "assignee = currentUser()") return f.assignee?.accountId === ALICE.accountId;
    if (c === "assignee is EMPTY") return !f.assignee;
    if ((m = /^assignee = (".*")$/.exec(c))) return f.assignee?.accountId === unquote(m[1]);
    if ((m = /^issuetype = (".*")$/.exec(c))) return f.issuetype.name === unquote(m[1]);
    if (c === "duedate < startOfDay()") return Boolean(f.duedate) && f.duedate < new Date().toISOString().slice(0, 10);
    if ((m = /^status = (.+)$/.exec(c))) return f.status.name.toLowerCase() === unquote(m[1]).toLowerCase();
    if ((m = /^priority = (.+)$/.exec(c))) return f.priority.name.toLowerCase() === unquote(m[1]).toLowerCase();
    if ((m = /^labels = (.+)$/.exec(c))) return f.labels.includes(unquote(m[1]));
    throw new Error(`The mock does not understand the JQL clause: ${c}`);
}

const keyOf = (issue) => [issue.project, Number(issue.key.split("-")[1])];
const SORT_FIELDS = {
    updated: (a, b) => a.fields.updated.localeCompare(b.fields.updated),
    created: (a, b) => a.fields.created.localeCompare(b.fields.created),
    duedate: (a, b) => (a.fields.duedate ?? "9999").localeCompare(b.fields.duedate ?? "9999"),
    priority: (a, b) => RANK[a.fields.priority.name] - RANK[b.fields.priority.name],
    key: (a, b) => keyOf(a)[0].localeCompare(keyOf(b)[0]) || keyOf(a)[1] - keyOf(b)[1],
};

export function evaluate(jql, all) {
    const order = /\s+ORDER BY\s+/i;
    const [filter, sorting = "updated DESC"] = jql.split(order);
    let rows = all;
    for (const clause of splitOutside(filter, " AND ")) rows = rows.filter((issue) => matches(clause, issue));
    const criteria = sorting.split(",").map((part) => {
        const [field, direction = "ASC"] = part.trim().split(/\s+/);
        if (!SORT_FIELDS[field]) throw new Error(`The mock cannot sort by ${field}`);
        return [SORT_FIELDS[field], direction.toUpperCase() === "DESC" ? -1 : 1];
    });
    return [...rows].sort((a, b) => {
        for (const [compare, direction] of criteria) {
            const result = compare(a, b) * direction;
            if (result) return result;
        }
        return 0;
    });
}

// ---- the server ---------------------------------------------------------------------------------------------------
/**
 * @param {{ layered?: boolean, sites?: object[], idPrefix?: string, pageCap?: number, extraTools?: {id: string, server: string, name: string}[] }} [options]
 */
export function createMockAtlassian({ layered = true, sites, idPrefix = "mock-", pageCap = Infinity, extraTools = [] } = {}) {
    const data = fixtures();
    const calls = [];
    const failures = new Map();
    const stats = { active: 0, maxActive: 0, latency: 0 };
    const state = { rejectExpand: false, user: ALICE };
    const resources = sites ?? [{ id: CLOUD_ID, url: SITE_URL, name: "acme", scopes: ["read:jira-work"], avatarUrl: "https://avatar.example/site" }];

    const rawOf = (issue) => ({ key: issue.key, id: issue.id, fields: { ...issue.fields } });
    const nodeOf = (issue) => ({ key: issue.key, id: issue.id, webUrl: `${SITE_URL}/browse/${issue.key}`, fields: { issuetype: { ...issue.fields.issuetype }, status: issue.fields.status, priority: issue.fields.priority, assignee: issue.fields.assignee } });
    const brief = (issue) => ({ key: issue.key, id: issue.id, fields: { summary: issue.fields.summary, status: issue.fields.status, issuetype: issue.fields.issuetype } });

    function issuePage(rows, size, token, extra = {}) {
        const offset = Number(token ?? 0) || 0;
        const slice = rows.slice(offset, offset + Math.min(size, pageCap));
        const isLast = offset + slice.length >= rows.length;
        return ok({ issues: slice.map(rawOf), isLast, ...(!isLast && { nextPageToken: String(offset + slice.length) }), ...extra }, { issues: { totalCount: rows.length, nodes: slice.map(nodeOf) } });
    }

    function valuesPage(values, { startAt = 0, maxResults = 50 } = {}) {
        const slice = values.slice(startAt, startAt + Math.min(maxResults, pageCap));
        return { values: slice, isLast: startAt + slice.length >= values.length, startAt, total: values.length };
    }

    const projects = () => data.projects.map((project) => ({ ...project }));

    const reads = {
        listJiraProjects: (inputs) => ok(valuesPage(projects(), inputs)),
        listJiraBoards: (inputs) => {
            let boards = data.boards;
            // projectKeyOrId finds every board whose filter mentions the space, including boards of other spaces.
            if (inputs.projectKeyOrId === "KAN") boards = [data.boards[1], data.boards[0]];
            else if (inputs.projectKeyOrId) boards = boards.filter((board) => board.location.projectKey === inputs.projectKeyOrId);
            return ok(valuesPage(boards, inputs));
        },
        getJiraBoardConfig: ({ boardId }) => (data.boardConfigs[boardId] ? ok(data.boardConfigs[boardId]) : fail(404, `Board ${boardId} does not exist`)),
        getJiraBoardIssueData: ({ boardId, dataset, maxResults = 50, nextPageToken }) => {
            const board = data.boards.find((candidate) => candidate.id === boardId);
            if (!board) return fail(404, `Board ${boardId} does not exist`);
            if (dataset === "backlog") return ok({ issues: [], isLast: true, returnHint: "Board type is TMP kanban; no backlog exists." }, { issues: { totalCount: 0, nodes: [] } });
            return issuePage(evaluate(`project = "${board.location.projectKey}"`, data.issues), maxResults, nextPageToken);
        },
        getJiraProjectVersions: ({ projectIdOrKey }) => (data.versions[projectIdOrKey] ? ok({ values: data.versions[projectIdOrKey] }) : fail(404, `Project ${projectIdOrKey} does not exist`)),
        listJiraProjectComponents: ({ projectIdOrKey }) => (data.components[projectIdOrKey] ? ok({ components: data.components[projectIdOrKey] }) : fail(404, `Project ${projectIdOrKey} does not exist`)),
        listConfluenceSpaces: () => ok({ results: data.confluenceSpaces, _links: {} }),
    };

    const pageContent = (page) => ({
        id: page.id,
        type: "page",
        title: page.title,
        space: page.space,
        version: { when: page.when, by: page.by },
        _links: { webui: `/spaces/${page.space.key}/pages/${page.id}`, base: `${SITE_URL}/wiki` },
    });

    const tools = {
        getAccessibleAtlassianResources: () => ok(resources),
        getVisibleJiraProjects: (args) => ok(valuesPage(projects(), { maxResults: args.maxResults })),
        getConfluenceSpaces: () => ok({ results: data.confluenceSpaces, _links: {} }),
        atlassianUserInfo: () => ok({ accountId: state.user.accountId }),
        searchJiraIssuesUsingJql: (args) => {
            const jql = args.jql ?? "";
            const unknown = [...jql.matchAll(/project = "([^"\\]*)"/g)].map((match) => match[1]).find((key) => !data.projects.some((project) => project.key === key));
            if (unknown) return fail(400, `Error in the JQL Query: The value '${unknown}' does not exist for the field 'project'.`);
            const rows = evaluate(jql, data.issues);
            if (args.searchResultMode === "count") return ok({ totalCount: rows.length }, { issues: { totalCount: rows.length, nodes: [] } });
            return issuePage(rows, args.maxResults ?? 50, args.nextPageToken);
        },
        getJiraIssue: ({ issueIdOrKey }) => {
            const issue = data.issues.find((candidate) => candidate.key === issueIdOrKey || candidate.id === issueIdOrKey);
            if (!issue) return fail(404, "Issue does not exist or you do not have permission to see it.");
            const fields = {
                ...issue.fields,
                description: issue.description,
                subtasks: issue.subtasks.map(brief),
                issuelinks: issue.links.map((link) => ({ type: link.type, ...(link.outwardIssue && { outwardIssue: brief(link.outwardIssue) }), ...(link.inwardIssue && { inwardIssue: brief(link.inwardIssue) }) })),
                components: issue.components,
                fixVersions: issue.fixVersions,
            };
            return ok({ key: issue.key, id: issue.id, fields }, { issues: { totalCount: 1, nodes: [nodeOf(issue)] } });
        },
        listJiraIssueComments: ({ issueIdOrKey, startAt = 0, maxResults = 50, orderBy = "created" }) => {
            if (!data.issues.some((issue) => issue.key === issueIdOrKey)) return fail(404, "Issue does not exist or you do not have permission to see it.");
            const all = data.comments[issueIdOrKey] ?? [];
            const ordered = orderBy === "-created" ? [...all].reverse() : all;
            const slice = ordered.slice(startAt, startAt + maxResults);
            return ok({ comments: slice, total: all.length, startAt, isLast: startAt + slice.length >= all.length });
        },
        searchConfluence: (args) => {
            if (state.rejectExpand && args.expand) return fail(400, "expand is not supported");
            const space = /space = "([^"]+)"/.exec(args.cql ?? "")?.[1];
            const word = /text ~ "([^"]+)"/.exec(args.cql ?? "")?.[1]?.toLowerCase();
            const rows = data.confluencePages.filter((page) => (!space || page.space.key === space) && (!word || `${page.title} ${page.body}`.toLowerCase().includes(word)));
            const offset = Number(args.cursor ?? 0) || 0;
            const slice = rows.slice(offset, offset + Math.min(args.limit ?? 25, pageCap));
            const more = offset + slice.length < rows.length;
            return ok({
                results: slice.map((page) => ({ content: pageContent(page), excerpt: `…@@@hl@@@${word ?? page.title}@@@endhl@@@ …`, lastModified: page.when, url: `/spaces/${page.space.key}/pages/${page.id}` })),
                totalSize: rows.length,
                _links: more ? { next: `/rest/api/search?cursor=${offset + slice.length}&limit=${args.limit ?? 25}` } : {},
            });
        },
        getConfluenceContent: ({ content_id: id }) => {
            const page = data.confluencePages.find((candidate) => candidate.id === id);
            return page ? ok({ ...pageContent(page), body: { markdown: { value: page.body } } }) : fail(404, "Content not found.");
        },
        executeRead: ({ name, inputs }) => (reads[name] ? reads[name](inputs ?? {}) : fail(400, `Unknown operation ${name}`)),
    };

    const names = [...Object.keys(tools).filter((name) => (layered ? name !== "getVisibleJiraProjects" && name !== "getConfluenceSpaces" : name !== "executeRead")), ...WRITE_TOOLS, ...OTHER_TOOLS.filter((name) => name !== "getJiraProjectVersions")];
    const idOf = (name) => `${idPrefix}${name}`;
    const nameOf = (id) => id.slice(idPrefix.length);

    async function run(name, args) {
        if (!names.includes(name)) return fail(404, `Unknown tool ${name}`);
        const operation = name === "executeRead" ? args?.name : undefined;
        calls.push({ name, args, ...(operation && { operation }) });
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        try {
            if (stats.latency) await sleep(stats.latency);
            const injected = failures.get(name) ?? (operation ? failures.get(operation) : undefined);
            if (injected) {
                // A function may return nothing to let this particular call through.
                const outcome = typeof injected === "function" ? injected(args) : fail(injected.statusCode, injected.message);
                if (outcome) return outcome;
            }
            if (!tools[name]) return fail(501, `${name} is not implemented by the mock`);
            return tools[name](args ?? {});
        } catch (error) {
            return { ok: false, text: "", structured: null, error: String(error?.message ?? error) };
        } finally {
            stats.active--;
        }
    }

    const toRpc = (result) => ({
        resultType: result.ok ? "success" : "failure",
        contents: result.ok ? [{ type: "text", text: result.text }] : [],
        ...(result.structured && { structuredContent: result.structured }),
        ...(!result.ok && { error: result.error }),
    });

    /** Appends `count` plain issues to a project and returns them. */
    const addIssues = (project, count, spec = {}) => {
        const existing = data.issues.filter((issue) => issue.project === project).length;
        const added = [];
        for (let k = 1; k <= count; k++) {
            const issue = makeIssue(project, existing + k, { summary: `Bulk issue ${existing + k}`, ...spec });
            data.issues.push(issue);
            added.push(issue);
        }
        return added;
    };

    return {
        data,
        calls,
        stats,
        state,
        addIssues,
        ok,
        failure: fail,
        /** Makes a tool (or an executeRead operation) fail: `{ statusCode, message }`, or a function that returns a result (or nothing to let the call through). */
        failWith: (name, failure) => failures.set(name, failure),
        clearFailures: () => failures.clear(),
        /** `[{ id, server, name }]`, as the host transports list them. */
        toolList: () => [...names.map((name) => ({ id: idOf(name), server: SERVER, name })), ...extraTools],
        /** `getCurrentMetadata()` of the Copilot session RPC. */
        metadata: () => ({
            tools: [...names.map((name) => ({ name: idOf(name), mcpServerName: SERVER, mcpToolName: name })), { name: "playwright-browser_click", mcpServerName: "playwright", mcpToolName: "browser_click" }, { name: "bash" }],
        }),
        transport: {
            tools: async () => [...names.map((name) => ({ id: idOf(name), server: SERVER, name })), ...extraTools],
            invoke: (id, args) => run(nameOf(id), args),
        },
        /** `session.rpc.tools.execute` of the Copilot app. */
        execute: async ({ name, arguments: args }) => toRpc(await run(nameOf(name), args)),
        call: run,
        calledTools: () => [...new Set(calls.map((call) => call.name))],
        calledOperations: () => [...new Set(calls.filter((call) => call.operation).map((call) => call.operation))],
        reset: () => {
            calls.length = 0;
        },
    };
}
