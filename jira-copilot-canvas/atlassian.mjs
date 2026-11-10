// Jira and Confluence access through the Atlassian MCP server of the host.
//
// This module never talks to a host API itself. It is handed a transport that lists the MCP tools the host exposes and
// invokes one of them, so the same code serves the Copilot app (session.rpc.tools) and VS Code (vscode.lm.tools).
// Everything here is read-only.

export class AtlassianError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AtlassianError";
        this.code = code;
    }
}

export const NOT_CONNECTED =
    "The Atlassian MCP server is not available in this session. Connect it (remote server https://mcp.atlassian.com/v1/mcp), sign in, then reopen the canvas.";

const TOOLS_TTL_MS = 20_000;
const SITES_TTL_MS = 5 * 60_000;
const CACHE_TTL_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
const HEDGE_AFTER_MS = 10_000;
const MAX_PARALLEL = 4;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 5;
const NO_RETRY = new Set(["auth", "forbidden", "not_found", "rate_limited", "not_connected", "timeout"]);
// The Atlassian tools that the canvas calls. All of them only read, so a request that gets lost can safely be sent again.
export const READ_TOOLS = Object.freeze(["getAccessibleAtlassianResources", "atlassianUserInfo", "getJiraIssue", "searchJiraIssuesUsingJql", "listJiraIssueComments", "getConfluenceContent", "searchConfluence", "executeRead", "getVisibleJiraProjects", "getConfluenceSpaces"]);
const REQUIRED_TOOLS = ["searchJiraIssuesUsingJql", "getJiraIssue"];
const ISSUE_FIELDS = ["summary", "status", "assignee", "priority", "issuetype", "labels", "duedate", "created", "updated", "parent"];
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const SPACE_RE = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const SORTS = { updated: "updated DESC", created: "created DESC", priority: "priority DESC, updated DESC", due: "duedate ASC, updated DESC", key: "key ASC" };
// Jira's status category ids: they do not change with the site language, unlike the names.
const CATEGORY_JQL = { todo: "statusCategory = 2", inprogress: "statusCategory = 4", done: "statusCategory = 3", open: "statusCategory != 3" };

// ---- small helpers ------------------------------------------------------------------------------------------------------
const str = (value) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const arr = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const httpsUrl = (value) => (typeof value === "string" && /^https:\/\//i.test(value) ? value : null);
const trimSlash = (value) => str(value).replace(/\/+$/, "");

function parseJson(value) {
    if (typeof value !== "string") return value ?? null;
    const text = value.trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function createLimiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max || !queue.length) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active--;
                next();
            });
    };
    return (fn) =>
        new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
}

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AtlassianError("timeout", message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Starts `attempt`. If it has not answered after `delayMs`, starts it once more and takes whichever answers first, so a
 * request that was lost costs `delayMs` and not the whole timeout. A failure before the delay is final. When both fail,
 * the first failure is the error.
 */
function hedged(attempt, delayMs) {
    return new Promise((resolve, reject) => {
        const errors = [];
        let started = 1;
        const failed = (error) => {
            errors.push(error);
            if (errors.length === started) reject(errors[0]);
        };
        const timer = setTimeout(() => {
            started = 2;
            attempt().then(resolve, failed);
        }, delayMs);
        attempt().then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                failed(error);
            },
        );
    });
}

// ---- status categories ------------------------------------------------------------------------------------------------------
const CATEGORY_KEYS = { new: "todo", indeterminate: "inprogress", done: "done", "2": "todo", "4": "inprogress", "3": "done" };

/** "todo" | "inprogress" | "done" from a status category key or name, or, as a last resort, a status name. */
export function categoryOf(...candidates) {
    let sawName = false;
    for (const candidate of candidates) {
        const value = str(candidate).trim().toLowerCase();
        if (!value) continue;
        sawName = true;
        if (CATEGORY_KEYS[value]) return CATEGORY_KEYS[value];
        if (/^(to ?do|open|backlog|new|selected for development|ready|à faire|a faire|por hacer|zu erledigen)$/.test(value)) return "todo";
        if (/in progress|in review|review|testing|doing|started|wip|en cours|en curso|in arbeit/.test(value)) return "inprogress";
        if (/^(done|closed|resolved|complete|completed|finished|released|terminé|termine|fait|hecho|erledigt|fertig)$/.test(value)) return "done";
    }
    return sawName ? "inprogress" : "todo";
}

// ---- JQL ------------------------------------------------------------------------------------------------------------------------
export const quoteJql = (value) => `"${str(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Characters Jira's text search treats as operators.
const textTerm = (value) => str(value).replace(/[+\-&|!(){}[\]^~*?\\:"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

/** Splits "status = Done ORDER BY created DESC" into the filter and the sort. */
export function splitOrderBy(jql) {
    const match = /\border\s+by\b/i.exec(jql);
    if (!match) return { clause: jql.trim(), orderBy: "" };
    return { clause: jql.slice(0, match.index).trim(), orderBy: jql.slice(match.index + match[0].length).trim() };
}

// A JQL filter is wrapped in parentheses to keep it inside the space; an unbalanced one could close the wrapper early.
function balanced(clause) {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < clause.length; i++) {
        const char = clause[i];
        if (quote) {
            if (char === "\\") i++;
            else if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "(") depth++;
        else if (char === ")" && --depth < 0) return false;
    }
    return depth === 0 && !quote;
}

/**
 * The JQL behind the issue list of a space.
 * `q` is plain text unless `qMode` is "jql", where it is a filter that is combined with the space and the other filters.
 */
export function buildJql({ space, q = "", qMode = "text", status = "all", assignee = "any", type = "", sort = "updated" } = {}) {
    const clauses = [];
    if (space) clauses.push(`project = ${quoteJql(space)}`);
    let order = SORTS[sort] ?? SORTS.updated;
    const text = str(q).trim();
    if (text) {
        if (qMode === "jql") {
            const { clause, orderBy } = splitOrderBy(text);
            if (clause) {
                if (!balanced(clause)) throw new AtlassianError("invalid", "The JQL filter has unbalanced parentheses or quotes.");
                clauses.push(`(${clause})`);
            }
            if (orderBy) order = orderBy;
        } else if (KEY_RE.test(text)) {
            clauses.push(`(key = ${quoteJql(text.toUpperCase())} OR text ~ ${quoteJql(textTerm(text) || text)})`);
        } else if (/^\d+$/.test(text) && space) {
            clauses.push(`(key = ${quoteJql(`${space}-${text}`)} OR text ~ ${quoteJql(text)})`);
        } else if (textTerm(text)) {
            clauses.push(`text ~ ${quoteJql(textTerm(text))}`);
        }
    }
    if (CATEGORY_JQL[status]) clauses.push(CATEGORY_JQL[status]);
    if (assignee === "me") clauses.push("assignee = currentUser()");
    else if (assignee === "unassigned") clauses.push("assignee is EMPTY");
    else if (/^[0-9a-f]{1,8}:[0-9a-f-]{20,}$|^[0-9a-f]{24}$/i.test(str(assignee))) clauses.push(`assignee = ${quoteJql(assignee)}`);
    if (str(type).trim()) clauses.push(`issuetype = ${quoteJql(str(type).trim())}`);
    return `${clauses.join(" AND ")} ORDER BY ${order}`.trim();
}

// ---- tool results ---------------------------------------------------------------------------------------------------------------
const STATUS_CODES = { 401: "auth", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

function failure(result, body) {
    let message = str(body?.message ?? body?.error?.message ?? "");
    let status = Number(body?.statusCode ?? body?.status) || 0;
    if (!message) {
        const raw = str(result.error || result.text);
        const start = raw.indexOf("{");
        const inner = start >= 0 ? parseJson(raw.slice(start)) : null;
        message = str(inner?.message ?? "") || raw.replace(/^MCP server '[^']*':\s*/, "");
        status ||= Number(inner?.statusCode) || 0;
    }
    message = message.trim() || "The Atlassian request failed.";
    const lower = message.toLowerCase();
    // A status code is decisive: Jira's own 404 reads "Issue does not exist or you do not have permission to see it."
    let code = STATUS_CODES[status] ?? "";
    if (!code) {
        if (/unauthori[sz]ed|not authenticated|authentication|sign in again|login required|token (?:has )?(?:expired|is invalid)|needs? auth|oauth|authorization required/.test(lower)) code = "auth";
        else if (/not found|does not exist|doesn't exist/.test(lower)) code = "not_found";
        else if (/forbidden|permission|not permitted|access denied/.test(lower)) code = "forbidden";
        else if (/rate limit|too many requests/.test(lower)) code = "rate_limited";
        else if (/not connected|disconnected|connection (?:closed|refused|reset)|failed to connect|server .* not running/.test(lower)) code = "not_connected";
        else if (/does not support|not supported|unsupported/.test(lower)) code = "unsupported";
        else if (status === 400) code = "invalid";
        else code = "upstream";
    }
    return new AtlassianError(code, message);
}

/**
 * Reads a transport result: `{ ok, text, structured, error }`.
 * `text` is the compact JSON block ({ data }); `structured` is the richer block with the raw Jira/Confluence fields.
 */
export function parseToolResult(result) {
    const body = parseJson(result?.text);
    if (!result?.ok || body?.error === true) throw failure(result ?? {}, body);
    const data = isObject(body) && "data" in body ? body.data : body ?? str(result.text);
    const rich = parseJson(result.structured);
    return { data, rich: rich ?? null };
}

// ---- Atlassian Document Format and HTML -> Markdown ---------------------------------------------------------------------
function marked(text, marks) {
    let out = text;
    for (const mark of arr(marks)) {
        if (mark?.type === "code") out = `\`${out}\``;
        else if (mark?.type === "strong") out = `**${out}**`;
        else if (mark?.type === "em") out = `*${out}*`;
        else if (mark?.type === "strike") out = `~~${out}~~`;
        else if (mark?.type === "link" && httpsUrl(mark.attrs?.href)) out = `[${out}](${mark.attrs.href})`;
    }
    return out;
}

function adfInline(nodes) {
    return arr(nodes)
        .map((node) => {
            switch (node?.type) {
                case "text":
                    return marked(str(node.text), node.marks);
                case "hardBreak":
                    return "\n";
                case "mention":
                    return str(node.attrs?.text || "@someone");
                case "emoji":
                    return str(node.attrs?.text || node.attrs?.shortName);
                case "inlineCard":
                    return str(node.attrs?.url);
                case "status":
                    return `[${str(node.attrs?.text)}]`;
                case "date": {
                    const time = Number(node.attrs?.timestamp);
                    return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
                }
                default:
                    return adfInline(node?.content);
            }
        })
        .join("");
}

function adfTable(table) {
    const rows = arr(table.content).map((row) => arr(row.content).map((cell) => adfBlocks(cell.content).replace(/\n+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row) => Array.from({ length: width }, (_, i) => row[i] ?? "");
    const [head, ...body] = rows;
    return [`| ${pad(head).join(" | ")} |`, `| ${pad(head).map(() => "---").join(" | ")} |`, ...body.map((row) => `| ${pad(row).join(" | ")} |`)].join("\n");
}

function adfList(list, depth) {
    const ordered = list.type === "orderedList";
    const indent = "  ".repeat(depth);
    return arr(list.content)
        .map((item, index) => {
            const marker = ordered ? `${(Number(list.attrs?.order) || 1) + index}.` : "-";
            return arr(item.content)
                .map((part, i) => {
                    if (part.type === "bulletList" || part.type === "orderedList") return adfList(part, depth + 1);
                    const text = adfBlocks([part], depth + 1);
                    return i === 0 ? `${indent}${marker} ${text}` : text.split("\n").map((line) => `${indent}  ${line}`).join("\n");
                })
                .join("\n");
        })
        .join("\n");
}

function adfBlocks(nodes, depth = 0) {
    const out = [];
    for (const node of arr(nodes)) {
        switch (node?.type) {
            case "paragraph":
                out.push(adfInline(node.content));
                break;
            case "heading":
                out.push(`${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${adfInline(node.content)}`);
                break;
            case "bulletList":
            case "orderedList":
                out.push(adfList(node, depth));
                break;
            case "codeBlock":
                out.push(`\`\`\`${str(node.attrs?.language)}\n${arr(node.content).map((child) => str(child.text)).join("")}\n\`\`\``);
                break;
            case "blockquote":
            case "panel":
                out.push(adfBlocks(node.content).split("\n").map((line) => `> ${line}`).join("\n"));
                break;
            case "rule":
                out.push("---");
                break;
            case "table":
                out.push(adfTable(node));
                break;
            case "mediaSingle":
            case "mediaGroup":
                out.push("[attachment]");
                break;
            default:
                if (node?.content) out.push(adfBlocks(node.content, depth));
                else if (node?.text) out.push(adfInline([node]));
        }
    }
    return out.filter((part) => part !== "").join("\n\n");
}

export const adfToMarkdown = (doc) => adfBlocks(isObject(doc) && doc.type === "doc" ? doc.content : [doc]).trim();

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function htmlToText(html) {
    return str(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>/gi, "\n\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Text of a description or a comment, whatever form the server returned it in. */
export function bodyText(value) {
    if (typeof value === "string") {
        const text = value.trim();
        if (text.startsWith("{")) {
            const doc = parseJson(text);
            if (doc?.type === "doc") return adfToMarkdown(doc);
        }
        return /^<[a-z!][\s\S]*>/i.test(text) ? htmlToText(text) : value;
    }
    if (isObject(value)) {
        if (value.type === "doc") return adfToMarkdown(value);
        for (const key of ["markdown", "value", "text", "body", "content"]) if (typeof value[key] === "string") return bodyText(value[key]);
    }
    return "";
}

// ---- normalizers ------------------------------------------------------------------------------------------------------------
function avatarOf(user) {
    const sizes = user.avatarUrls;
    return httpsUrl(sizes?.["48x48"] ?? sizes?.["32x32"] ?? sizes?.["24x24"] ?? sizes?.["16x16"] ?? user.avatarUrl ?? user.picture);
}

function userOf(...sources) {
    const merged = Object.assign({}, ...sources.filter(isObject));
    if (!Object.keys(merged).length) return null;
    const name = str(merged.displayName ?? merged.name ?? merged.emailAddress ?? merged.accountId ?? "");
    return { id: str(merged.accountId ?? merged.id ?? ""), name, avatar: avatarOf(merged) };
}

function statusOf(...sources) {
    const status = sources.find((source) => isObject(source) && source.name);
    if (!status) return { name: "", category: "todo" };
    const rich = sources.find((source) => source?.statusCategory?.key)?.statusCategory;
    return { name: str(status.name), id: str(status.id ?? ""), category: categoryOf(rich?.key, status.statusCategory?.key, status.statusCategory?.name, status.name) };
}

function briefIssue(issue) {
    const fields = issue?.fields ?? {};
    return { key: str(issue?.key), summary: str(fields.summary), status: statusOf(fields.status), type: str(fields.issuetype?.name) };
}

function parentOf(...sources) {
    const parent = sources.find((source) => isObject(source) && source.key);
    return parent ? briefIssue(parent) : null;
}

function normalizeIssue(raw, node, site) {
    const f = raw?.fields ?? {};
    const r = node?.fields ?? {};
    const key = str(raw?.key ?? node?.key);
    const priority = f.priority ?? r.priority;
    const type = f.issuetype ?? r.issuetype;
    return {
        key,
        id: str(raw?.id ?? node?.id),
        url: httpsUrl(node?.webUrl) ?? `${trimSlash(site.url)}/browse/${key}`,
        summary: str(f.summary ?? r.summary),
        status: statusOf(f.status, r.status),
        type: { name: str(type?.name), subtask: Boolean(r.issuetype?.subtask ?? f.issuetype?.subtask), level: Number.isFinite(r.issuetype?.hierarchyLevel) ? r.issuetype.hierarchyLevel : null },
        priority: priority?.name ? { name: str(priority.name) } : null,
        assignee: userOf(f.assignee, r.assignee),
        reporter: userOf(f.reporter, r.reporter),
        labels: arr(f.labels ?? r.labels).map(str).filter(Boolean),
        created: str(f.created ?? r.created),
        updated: str(f.updated ?? r.updated),
        due: str(f.duedate ?? r.duedate),
        parent: parentOf(f.parent, r.parent),
    };
}

function richNodes(rich) {
    const nodes = rich?.issues?.nodes ?? rich?.nodes ?? [];
    return new Map(arr(nodes).map((node) => [str(node?.key), node]));
}

function issuesFrom({ data, rich }, site) {
    const nodes = richNodes(rich);
    const list = arr(data?.issues);
    return list.map((raw) => normalizeIssue(raw, nodes.get(str(raw?.key)), site));
}

function normalizeProject(project, site) {
    const key = str(project?.key);
    return {
        key,
        id: str(project?.id),
        name: str(project?.name || key),
        type: str(project?.projectTypeKey),
        style: str(project?.style),
        lead: userOf(project?.lead),
        url: `${trimSlash(site.url)}/browse/${key}`,
    };
}

// The board list names the space projectKey/projectName, the board configuration names it key/name.
function normalizeBoard(board, site) {
    const location = board?.location ?? {};
    const projectKey = str(location.projectKey ?? location.key);
    return {
        id: Number(board?.id),
        name: str(board?.name || `Board ${board?.id}`),
        type: str(board?.type),
        isPrivate: Boolean(board?.isPrivate),
        space: projectKey ? { key: projectKey, name: str(location.projectName ?? location.displayName ?? location.name ?? projectKey) } : null,
        url: projectKey ? `${trimSlash(site.url)}/jira/software/projects/${projectKey}/boards/${board?.id}` : null,
    };
}

const normalizeVersion = (version) => ({
    id: str(version?.id),
    name: str(version?.name),
    description: str(version?.description),
    released: Boolean(version?.released),
    archived: Boolean(version?.archived),
    startDate: str(version?.startDate),
    releaseDate: str(version?.releaseDate),
    overdue: Boolean(version?.overdue),
});

const normalizeComponent = (component) => ({
    id: str(component?.id),
    name: str(component?.name),
    description: str(component?.description),
    lead: userOf(component?.lead),
    assignee: userOf(component?.realAssignee, component?.assignee),
    issueCount: Number.isFinite(component?.issueCount) ? component.issueCount : null,
});

const normalizeComment = (comment) => ({
    id: str(comment?.id),
    author: userOf(comment?.author),
    body: bodyText(comment?.body),
    created: str(comment?.created),
    updated: str(comment?.updated),
    internal: comment?.jsdPublic === false,
});

const stripHighlights = (value) => str(value).replace(/@@@(?:end)?hl@@@/g, "");

function absoluteWiki(site, base, link) {
    const path = str(link);
    if (httpsUrl(path)) return path;
    if (!path) return null;
    const root = httpsUrl(base) ? trimSlash(base) : `${trimSlash(site.url)}/wiki`;
    return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeConfluenceSpace(space, site) {
    return {
        id: str(space?.id),
        key: str(space?.key),
        name: str(space?.name || space?.key),
        type: str(space?.type),
        status: str(space?.status),
        description: bodyText(space?.description?.plain ?? space?.description),
        url: absoluteWiki(site, space?._links?.base, space?._links?.webui ?? (space?.key ? `/spaces/${space.key}` : "")),
    };
}

// Search results are either content objects or wrappers around them, depending on the endpoint behind the tool.
function normalizePage(row, site) {
    const content = isObject(row?.content) ? row.content : row;
    const links = content?._links ?? row?._links ?? {};
    const space = content?.space ?? row?.space ?? row?.resultGlobalContainer ?? {};
    const author = content?.version?.by ?? content?.history?.createdBy ?? content?.author;
    return {
        id: str(content?.id ?? row?.id),
        title: stripHighlights(content?.title ?? row?.title),
        type: str(content?.type ?? row?.entityType ?? row?.type ?? "page"),
        excerpt: stripHighlights(row?.excerpt ?? ""),
        space: { key: str(space.key ?? row?.spaceKey ?? ""), name: stripHighlights(space.name ?? space.title ?? "") },
        modified: str(row?.lastModified ?? content?.version?.when ?? content?.history?.lastUpdated?.when ?? content?.lastModified ?? ""),
        author: userOf(isObject(author) ? author : null),
        url: absoluteWiki(site, links.base, links.webui ?? row?.url ?? content?.url),
    };
}

const cursorFrom = (next) => {
    if (!next) return null;
    const direct = parseJson(next);
    if (isObject(direct)) return str(direct.cursor) || null;
    try {
        return new URL(str(next), "https://example.invalid").searchParams.get("cursor");
    } catch {
        return null;
    }
};

const listOf = (data, ...keys) => {
    if (Array.isArray(data)) return data;
    for (const key of [...keys, "values", "results", "items"]) if (Array.isArray(data?.[key])) return data[key];
    return [];
};

/**
 * @param {{ transport: { tools(): Promise<{id: string, server: string, name: string}[]>, invoke(id: string, args: object): Promise<{ok: boolean, text: string, structured?: unknown, error?: string}> }, now?: () => number, hedgeMs?: number }} deps
 */
export function createAtlassian({ transport, now = Date.now, hedgeMs = HEDGE_AFTER_MS }) {
    const limit = createLimiter(MAX_PARALLEL);
    let toolbox = null;
    let siteCache = null;
    let sitesLoad = null;
    let epoch = 0;
    const memo = new Map();

    function cached(key, ttl, load) {
        const hit = memo.get(key);
        if (hit && now() - hit.at < ttl) return hit.value;
        const value = Promise.resolve().then(load);
        memo.set(key, { at: now(), value });
        value.catch(() => {
            if (memo.get(key)?.value === value) memo.delete(key);
        });
        return value;
    }

    async function tools({ force = false } = {}) {
        if (!force && toolbox && now() - toolbox.at < TOOLS_TTL_MS) return toolbox;
        let list;
        try {
            list = await transport.tools();
        } catch (error) {
            throw new AtlassianError("not_connected", `${NOT_CONNECTED} (${str(error?.message ?? error)})`);
        }
        const servers = new Map();
        for (const tool of arr(list)) {
            if (!tool?.server || !tool?.name) continue;
            if (!servers.has(tool.server)) servers.set(tool.server, new Map());
            servers.get(tool.server).set(tool.name, tool.id);
        }
        let best = null;
        for (const [server, byName] of servers) {
            if (!REQUIRED_TOOLS.every((name) => byName.has(name))) continue;
            const score = byName.size + (byName.has("executeRead") ? 100 : 0);
            if (!best || score > best.score) best = { server, byName, score };
        }
        if (!best) {
            toolbox = null;
            throw new AtlassianError("not_connected", NOT_CONNECTED);
        }
        toolbox = { at: now(), server: best.server, byName: best.byName, layered: best.byName.has("executeRead") };
        return toolbox;
    }

    async function call(name, args) {
        const box = await tools();
        const id = box.byName.get(name);
        if (!id) throw new AtlassianError("unsupported", `The Atlassian MCP server does not provide ${name}.`);
        let result;
        const attempt = () => Promise.resolve().then(() => transport.invoke(id, args));
        try {
            result = await limit(() => withTimeout(READ_TOOLS.includes(name) ? hedged(attempt, hedgeMs) : attempt(), CALL_TIMEOUT_MS, `Atlassian did not answer ${name} in time.`));
        } catch (error) {
            if (error instanceof AtlassianError) throw error;
            throw new AtlassianError("upstream", `Calling ${name} failed: ${str(error?.message ?? error)}`);
        }
        return parseToolResult(result);
    }

    // Jira and Confluence reads of the layered toolset go through one generic tool.
    async function read(site, operation, inputs = {}) {
        const box = await tools();
        if (!box.layered) throw new AtlassianError("unsupported", `This Atlassian MCP server does not offer ${operation}.`);
        return call("executeRead", { cloudId: site.cloudId, name: operation, inputs });
    }

    async function sites({ force = false } = {}) {
        if (!force && siteCache && now() - siteCache.at < SITES_TTL_MS) return siteCache.list;
        // The panel asks for several things at once when it opens; they share one lookup.
        if (!force && sitesLoad) return sitesLoad;
        const generation = epoch;
        const load = (async () => {
            const { data } = await call("getAccessibleAtlassianResources", {});
            const list = listOf(data, "resources")
                .map((resource) => {
                    const cloudId = str(resource?.cloudId ?? resource?.id);
                    const url = trimSlash(resource?.url);
                    let name = str(resource?.name);
                    if (!name && url) {
                        try {
                            name = new URL(url).hostname.split(".")[0];
                        } catch {
                            name = url;
                        }
                    }
                    const products = arr(resource?.products).map((product) => str(product?.id ?? product?.name ?? product).toLowerCase());
                    return { cloudId, url, name, jira: !products.length || products.some((p) => p.includes("jira")), confluence: !products.length || products.some((p) => p.includes("confluence")) };
                })
                .filter((site) => site.cloudId && site.url);
            if (generation === epoch) siteCache = { at: now(), list };
            return list;
        })().finally(() => {
            if (sitesLoad === load) sitesLoad = null;
        });
        sitesLoad = load;
        return load;
    }

    async function siteFor(wanted, product = "jira") {
        const list = await sites();
        if (!list.length) throw new AtlassianError("not_connected", "No Atlassian site is accessible with this account.");
        const name = str(wanted).trim();
        if (name) {
            const found = list.find((site) => site.cloudId === name || site.url === name || site.name === name);
            if (!found) throw new AtlassianError("not_found", `Unknown Atlassian site "${name}".`);
            return found;
        }
        return list.find((site) => site[product]) ?? list[0];
    }

    const clearCache = () => {
        memo.clear();
        siteCache = null;
        sitesLoad = null;
        toolbox = null;
        epoch++;
    };

    // ---- Jira: spaces -------------------------------------------------------------------------------------------------------
    async function listSpaces({ site: wanted } = {}) {
        const site = await siteFor(wanted);
        const spaces = await cached(`spaces:${site.cloudId}`, CACHE_TTL_MS, async () => {
            const box = await tools();
            const collected = [];
            if (box.layered) {
                for (let start = 0, page = 0; page < MAX_PAGES; page++) {
                    const { data } = await read(site, "listJiraProjects", { expand: "lead", maxResults: MAX_PAGE_SIZE, orderBy: "name", startAt: start });
                    const values = listOf(data);
                    collected.push(...values);
                    if (data?.isLast !== false || !values.length) break;
                    start += values.length;
                }
            } else {
                const { data } = await call("getVisibleJiraProjects", { cloudId: site.cloudId, maxResults: MAX_PAGE_SIZE });
                collected.push(...listOf(data));
            }
            return collected.map((project) => normalizeProject(project, site)).filter((space) => space.key);
        });
        return { site, spaces };
    }

    async function spaceInfo(site, key) {
        try {
            const { spaces } = await listSpaces({ site: site.cloudId });
            return spaces.find((space) => space.key.toLowerCase() === key.toLowerCase()) ?? null;
        } catch {
            return null;
        }
    }

    // ---- Jira: boards -------------------------------------------------------------------------------------------------------
    async function listBoards({ site: wanted, space } = {}) {
        const site = await siteFor(wanted);
        const key = str(space).trim();
        const boards = await cached(`boards:${site.cloudId}:${key}`, CACHE_TTL_MS, async () => {
            const box = await tools();
            if (!box.layered) return [];
            const collected = [];
            for (let start = 0, page = 0; page < MAX_PAGES; page++) {
                const inputs = { startAt: start, maxResults: PAGE_SIZE, ...(key && { projectKeyOrId: key }) };
                const { data } = await read(site, "listJiraBoards", inputs);
                const values = listOf(data);
                collected.push(...values);
                if (data?.isLast !== false || !values.length) break;
                start += values.length;
            }
            const boards = collected.map((board) => normalizeBoard(board, site)).filter((board) => Number.isFinite(board.id));
            // projectKeyOrId matches boards whose filter mentions the space, so boards that live in the space come first.
            return key ? boards.sort((a, b) => Number(b.space?.key === key.toUpperCase()) - Number(a.space?.key === key.toUpperCase()) || a.name.localeCompare(b.name)) : boards;
        });
        return { site, boards };
    }

    async function getBoard({ site: wanted, id, backlog = false, cursor } = {}) {
        const site = await siteFor(wanted);
        const boardId = Number(id);
        if (!Number.isInteger(boardId) || boardId < 1) throw new AtlassianError("invalid", "The board id must be a positive integer.");
        const box = await tools();
        if (!box.layered) throw new AtlassianError("unsupported", "Boards need the layered Atlassian MCP toolset (executeRead).");
        const [config, issues] = await Promise.all([
            cached(`board-config:${site.cloudId}:${boardId}`, CACHE_TTL_MS, async () => (await read(site, "getJiraBoardConfig", { boardId })).data),
            read(site, "getJiraBoardIssueData", { boardId, dataset: backlog ? "backlog" : "board", maxResults: MAX_PAGE_SIZE, fields: ISSUE_FIELDS, ...(cursor && { nextPageToken: cursor }) }),
        ]);
        const items = issuesFrom(issues, site);
        let columns = arr(config?.columnConfig?.columns).map((column, index) => ({
            index,
            name: str(column?.name || `Column ${index + 1}`),
            statuses: arr(column?.statuses).map((status) => ({ id: str(status?.id), name: str(status?.name), category: categoryOf(status?.category, status?.statusCategory?.key, status?.name) })),
        }));
        if (!columns.length) {
            // A board without column configuration: one column per status that shows up, in workflow order.
            const order = { todo: 0, inprogress: 1, done: 2 };
            const names = [...new Map(items.map((item) => [item.status.name.toLowerCase(), item.status])).values()].sort((a, b) => order[a.category] - order[b.category]);
            columns = names.map((status, index) => ({ index, name: status.name, statuses: [{ id: status.id ?? "", name: status.name, category: status.category }] }));
        }
        const byId = new Map();
        const byName = new Map();
        for (const column of columns) {
            for (const status of column.statuses) {
                if (status.id) byId.set(status.id, column.index);
                byName.set(status.name.toLowerCase(), column.index);
            }
        }
        const placed = items.map((item) => ({ ...item, column: byId.get(item.status.id) ?? byName.get(item.status.name.toLowerCase()) ?? -1 }));
        const next = issues.data?.isLast === false ? str(issues.data?.nextPageToken) || null : null;
        return {
            site,
            board: normalizeBoard({ id: boardId, ...config }, site),
            backlog: Boolean(backlog),
            columns,
            issues: placed,
            nextCursor: next,
            hint: str(issues.data?.returnHint) || null,
        };
    }

    // ---- Jira: issues -------------------------------------------------------------------------------------------------------
    async function searchRaw(site, jql, { cursor, limit: size = PAGE_SIZE } = {}) {
        const result = await call("searchJiraIssuesUsingJql", {
            cloudId: site.cloudId,
            jql,
            maxResults: Math.min(Math.max(Number(size) || PAGE_SIZE, 1), MAX_PAGE_SIZE),
            fields: ISSUE_FIELDS,
            ...(cursor && { nextPageToken: cursor }),
        });
        const isLast = result.data?.isLast !== false;
        return { items: issuesFrom(result, site), nextCursor: isLast ? null : str(result.data?.nextPageToken) || null, isLast };
    }

    async function countRaw(site, jql) {
        const { data, rich } = await call("searchJiraIssuesUsingJql", { cloudId: site.cloudId, jql, searchResultMode: "count" });
        const total = Number(data?.totalCount ?? rich?.issues?.totalCount);
        return Number.isFinite(total) ? total : null;
    }

    const requireSpace = (space) => {
        const key = str(space).trim();
        if (!SPACE_RE.test(key)) throw new AtlassianError("invalid", "A Jira space key looks like KAN (letters, digits or underscores).");
        return key.toUpperCase();
    };

    async function searchIssues({ site: wanted, space, cursor, limit: size, ...filter } = {}) {
        const site = await siteFor(wanted);
        const jql = buildJql({ ...filter, space: requireSpace(space) });
        const typed = filter.qMode === "jql" && str(filter.q).trim() !== "";
        const page = await searchRaw(site, jql, { cursor, limit: size }).catch((error) => {
            // Jira words a mistyped field or value as "does not exist", which would read as a missing space.
            throw typed && error instanceof AtlassianError && error.code === "not_found" ? new AtlassianError("invalid", error.message) : error;
        });
        return { site, jql, ...page };
    }

    async function spaceSummary({ site: wanted, space } = {}) {
        const site = await siteFor(wanted);
        const key = requireSpace(space);
        const scope = `project = ${quoteJql(key)}`;
        const [info, first] = await Promise.all([spaceInfo(site, key), searchRaw(site, `${scope} ORDER BY updated DESC`, { limit: MAX_PAGE_SIZE })]);
        const items = first.items;
        const today = new Date().toISOString().slice(0, 10);
        const tally = (pick) => {
            const counts = new Map();
            for (const item of items) {
                const name = pick(item);
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
            return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        };
        const sample = {
            total: items.length,
            todo: items.filter((item) => item.status.category === "todo").length,
            inprogress: items.filter((item) => item.status.category === "inprogress").length,
            done: items.filter((item) => item.status.category === "done").length,
            overdue: items.filter((item) => item.due && item.due < today && item.status.category !== "done").length,
            unassigned: items.filter((item) => !item.assignee && item.status.category !== "done").length,
        };
        let counts = sample;
        let exact = first.isLast;
        if (!first.isLast) {
            // The first page is only a sample, so ask Jira for exact totals.
            const queries = [scope, `${scope} AND ${CATEGORY_JQL.todo}`, `${scope} AND ${CATEGORY_JQL.inprogress}`, `${scope} AND ${CATEGORY_JQL.done}`, `${scope} AND duedate < startOfDay() AND ${CATEGORY_JQL.open}`, `${scope} AND assignee is EMPTY AND ${CATEGORY_JQL.open}`];
            const totals = await Promise.all(queries.map((jql) => countRaw(site, jql).catch(() => null)));
            if (totals.every((value) => value !== null)) {
                counts = { total: totals[0], todo: totals[1], inprogress: totals[2], done: totals[3], overdue: totals[4], unassigned: totals[5] };
                exact = true;
            }
        }
        return {
            site,
            space: info ?? { key, id: "", name: key, type: "", style: "", lead: null, url: `${trimSlash(site.url)}/browse/${key}` },
            counts,
            exact,
            sampled: items.length,
            byType: tally((item) => item.type.name || "Unknown"),
            byPriority: tally((item) => item.priority?.name ?? "None"),
            byAssignee: tally((item) => item.assignee?.name ?? "Unassigned").slice(0, 8),
            recent: items.slice(0, 8),
        };
    }

    /** `newestComments` reads the latest comments (oldest of those first) instead of the first page, for callers that cannot page. */
    async function getIssue({ site: wanted, key, newestComments = false } = {}) {
        const site = await siteFor(wanted);
        const issueKey = str(key).trim().toUpperCase();
        if (!KEY_RE.test(issueKey)) throw new AtlassianError("invalid", "An issue key looks like KAN-12.");
        const box = await tools();
        const [issueResult, comments] = await Promise.all([
            call("getJiraIssue", { cloudId: site.cloudId, issueIdOrKey: issueKey, ...(box.layered && { view: "evidence" }) }),
            listComments({ site: site.cloudId, key: issueKey, newestFirst: newestComments })
                .then((page) => (newestComments ? { ...page, items: [...page.items].reverse(), nextStart: null } : page))
                .catch((error) => ({ items: [], total: 0, nextStart: null, error: error.message })),
        ]);
        const { data, rich } = issueResult;
        const raw = isObject(data?.fields) ? data : isObject(data?.issue) ? data.issue : data;
        const node = arr(rich?.issues?.nodes)[0] ?? rich?.issue ?? null;
        const f = raw?.fields ?? {};
        const r = node?.fields ?? {};
        const issue = normalizeIssue(raw, node, site);
        const links = arr(f.issuelinks ?? r.issuelinks).map((link) => {
            const other = link.inwardIssue ?? link.outwardIssue;
            const inward = Boolean(link.inwardIssue);
            return { type: str(link.type?.name), label: str(inward ? link.type?.inward : link.type?.outward) || str(link.type?.name), issue: briefIssue(other) };
        }).filter((link) => link.issue.key);
        const subtasks = arr(f.subtasks ?? r.subtasks).map(briefIssue).filter((subtask) => subtask.key);
        const fallbackComments = arr(r.comment?.comments ?? f.comment?.comments).map(normalizeComment);
        const commentTotal = Number(f.comment?.total ?? r.comment?.total);
        const shown = comments.error && fallbackComments.length ? { items: fallbackComments, total: fallbackComments.length, nextStart: null } : comments;
        return {
            ...issue,
            description: bodyText(f.description) || bodyText(r.description),
            resolution: str(r.resolution?.name ?? f.resolution?.name),
            components: arr(r.components ?? f.components).map((component) => str(component?.name)).filter(Boolean),
            fixVersions: arr(r.fixVersions ?? f.fixVersions).map((version) => str(version?.name)).filter(Boolean),
            subtasks,
            links,
            comments: { items: shown.items, total: Number.isFinite(commentTotal) ? Math.max(commentTotal, shown.total ?? 0) : shown.total ?? shown.items.length, nextStart: shown.nextStart, error: shown.error ?? null },
        };
    }

    async function listComments({ site: wanted, key, start = 0, limit: size = 30, newestFirst = false } = {}) {
        const site = await siteFor(wanted);
        const issueKey = str(key).trim().toUpperCase();
        if (!KEY_RE.test(issueKey)) throw new AtlassianError("invalid", "An issue key looks like KAN-12.");
        const { data } = await call("listJiraIssueComments", {
            cloudId: site.cloudId,
            issueIdOrKey: issueKey,
            maxResults: Math.min(Math.max(Number(size) || 30, 1), MAX_PAGE_SIZE),
            startAt: Math.max(Number(start) || 0, 0),
            orderBy: newestFirst ? "-created" : "created",
            responseContentFormat: "markdown",
        });
        const items = arr(data?.comments).map(normalizeComment);
        const total = Number.isFinite(data?.total) ? data.total : items.length;
        const offset = Math.max(Number(start) || 0, 0) + items.length;
        return { items, total, nextStart: data?.isLast === false && items.length && offset < total ? offset : null };
    }

    // ---- Jira: releases and components ----------------------------------------------------------------------------------
    async function listVersions({ site: wanted, space } = {}) {
        const site = await siteFor(wanted);
        const key = requireSpace(space);
        return cached(`versions:${site.cloudId}:${key}`, CACHE_TTL_MS, async () => {
            const { data } = await read(site, "getJiraProjectVersions", { projectIdOrKey: key, maxResults: MAX_PAGE_SIZE });
            const items = listOf(data).map(normalizeVersion).filter((version) => version.name);
            items.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "") || a.name.localeCompare(b.name));
            return { site, items };
        });
    }

    async function listComponents({ site: wanted, space } = {}) {
        const site = await siteFor(wanted);
        const key = requireSpace(space);
        return cached(`components:${site.cloudId}:${key}`, CACHE_TTL_MS, async () => {
            const { data } = await read(site, "listJiraProjectComponents", { projectIdOrKey: key, maxResults: MAX_PAGE_SIZE });
            const items = listOf(data, "components").map(normalizeComponent).filter((component) => component.name);
            return { site, items };
        });
    }

    // ---- Confluence ---------------------------------------------------------------------------------------------------------
    async function listConfluenceSpaces({ site: wanted } = {}) {
        const site = await siteFor(wanted, "confluence");
        return cached(`csp:${site.cloudId}`, CACHE_TTL_MS, async () => {
            const box = await tools();
            const { data } = box.layered ? await read(site, "listConfluenceSpaces", { limit: 100 }) : await call("getConfluenceSpaces", { cloudId: site.cloudId, limit: 100 });
            const items = listOf(data, "spaces").map((space) => normalizeConfluenceSpace(space, site)).filter((space) => space.key);
            items.sort((a, b) => a.name.localeCompare(b.name));
            return { site, items, hasMore: Boolean(cursorFrom(data?._links?.next)) };
        });
    }

    async function cql(site, query, { cursor, limit: size = PAGE_SIZE } = {}) {
        const base = { cloudId: site.cloudId, cql: query, limit: Math.min(Math.max(Number(size) || PAGE_SIZE, 1), MAX_PAGE_SIZE), ...(cursor && { cursor }) };
        let result;
        try {
            result = await call("searchConfluence", { ...base, expand: "space,version" });
        } catch (error) {
            // A server that rejects `expand` can say so in several ways; anything that is not about access or connectivity gets one plain retry.
            if (NO_RETRY.has(error.code)) throw error;
            result = await call("searchConfluence", base);
        }
        const rows = listOf(result.data, "results");
        const total = Number(result.data?.totalSize);
        return {
            items: rows.map((row) => normalizePage(row, site)).filter((page) => page.id || page.title),
            nextCursor: cursorFrom(result.data?._links?.next ?? result.data?.nextCursor ?? result.data?.cursor),
            total: Number.isFinite(total) ? total : null,
        };
    }

    async function listConfluencePages({ site: wanted, space, cursor } = {}) {
        const site = await siteFor(wanted, "confluence");
        const key = str(space).trim();
        if (!key || key.length > 80) throw new AtlassianError("invalid", "Give the key of a Confluence space.");
        const page = await cql(site, `type = page AND space = ${quoteJql(key)} ORDER BY lastmodified DESC`, { cursor });
        return { site, ...page };
    }

    async function searchConfluence({ site: wanted, q, cursor } = {}) {
        const site = await siteFor(wanted, "confluence");
        const text = textTerm(q);
        if (!text) throw new AtlassianError("invalid", "Enter something to search for.");
        const page = await cql(site, `type in (page, blogpost) AND text ~ ${quoteJql(text)}`, { cursor });
        return { site, ...page };
    }

    async function getConfluencePage({ site: wanted, id } = {}) {
        const site = await siteFor(wanted, "confluence");
        const contentId = str(id).trim();
        if (!/^\d{1,20}$/.test(contentId)) throw new AtlassianError("invalid", "A Confluence page id is a number.");
        const { data, rich } = await call("getConfluenceContent", { cloudId: site.cloudId, content_id: contentId, content_format: "markdown", detail: "full" });
        const content = isObject(data?.content) ? data.content : isObject(data) ? data : {};
        const body = content.body;
        const candidates = [data?.markdown, content.markdown, typeof data === "string" ? data : null, typeof content.body === "string" ? content.body : null, body?.markdown?.value, body?.atlas_doc_format?.value, body?.view?.value, body?.storage?.value, content.text, typeof content.content === "string" ? content.content : null];
        const text = candidates.map((candidate) => bodyText(candidate)).find((candidate) => candidate.trim()) ?? "";
        const page = normalizePage({ ...content, _links: content._links ?? rich?._links }, site);
        return { site, ...page, id: page.id || contentId, body: text };
    }

    async function diagnose({ site: wanted } = {}) {
        const box = await tools({ force: true });
        const report = { server: box.server, layered: box.layered, tools: [...box.byName.keys()].sort() };
        try {
            const list = await sites({ force: true });
            report.sites = list.map(({ cloudId, url, name, jira, confluence }) => ({ cloudId, url, name, jira, confluence }));
            const site = await siteFor(wanted);
            report.site = site.url;
            if (box.byName.has("atlassianUserInfo")) {
                const info = await call("atlassianUserInfo", {}).catch((error) => ({ data: { error: error.message } }));
                const user = isObject(info.data) ? info.data : {};
                // The real server answers with the account ID alone; a name is used when a server offers one.
                report.signedInAs = str(user.displayName ?? user.name ?? user.email ?? user.accountId ?? user.account_id ?? user.error ?? "") || null;
            }
        } catch (error) {
            report.error = { code: error.code ?? "error", message: error.message };
        }
        return report;
    }

    return {
        tools,
        sites,
        siteFor,
        clearCache,
        listSpaces,
        listBoards,
        getBoard,
        searchIssues,
        spaceSummary,
        getIssue,
        listComments,
        listVersions,
        listComponents,
        listConfluenceSpaces,
        listConfluencePages,
        searchConfluence,
        getConfluencePage,
        diagnose,
    };
}

export const patterns = Object.freeze({ KEY_RE, SPACE_RE });
