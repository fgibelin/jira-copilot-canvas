// Pieces shared by the views and the drawer: states, loaders, and the work item row and card.
import { avatar, dayLabel, dueStatus, fullTime, h, icon, labelChip, plural, priorityIcon, relTime, setChildren, typeBadge } from "./dom.js";
import { openIssue, openLaunch, state, track } from "./state.js";

// ---- states -------------------------------------------------------------------------------------------------------
export function stateBox({ iconName = "info", title, text, actions = [], tone = "" }) {
    return h(
        "div",
        { class: `state-box ${tone}`.trim() },
        h("div", { class: "state-box-icon" }, icon(iconName, { size: 24 })),
        h("h2", { class: "state-box-title" }, title),
        text ? h("p", { class: "state-box-text" }, text) : null,
        actions.length ? h("div", { class: "state-box-actions" }, actions) : null,
    );
}

export function button(label, onclick, { kind = "", iconName, title, disabled } = {}) {
    return h("button", { class: `btn ${kind}`.trim(), type: "button", onclick, title, disabled }, iconName ? icon(iconName, { size: 14 }) : null, label);
}

export const linkButton = (label, onclick) => h("button", { class: "link-btn", type: "button", onclick }, label);

export function externalLink(href, text, { cls = "" } = {}) {
    return h("a", { class: `ext ${cls}`.trim(), href, target: "_blank", rel: "noopener noreferrer" }, text, icon("external", { size: 12 }));
}

const ERROR_TITLES = {
    not_connected: "Atlassian is not connected",
    auth: "Sign in to Atlassian again",
    forbidden: "No access to this content",
    not_found: "Not found",
    invalid: "Check your search",
    unsupported: "Not available here",
    rate_limited: "Atlassian is rate limiting requests",
    outdated_server: "The canvas needs a restart",
    no_token: "Reopen the canvas",
    network: "Lost connection to the canvas",
};
const NO_RETRY = new Set(["outdated_server", "no_token", "invalid"]);

/** The server's message already says what to do (for example how to connect Atlassian), so it is shown as is. */
export function errorBox(error, retry, title) {
    const code = error?.code ?? "error";
    return stateBox({
        iconName: "alert",
        tone: "error",
        title: ERROR_TITLES[code] ?? title ?? "Something went wrong",
        text: error?.message ?? String(error),
        actions: retry && !NO_RETRY.has(code) ? [button("Try again", retry)] : [],
    });
}

export const viewHead = (title, { count, note, actions } = {}) =>
    h(
        "div",
        { class: "view-head" },
        h("div", { class: "view-head-text" }, h("h2", { class: "view-title" }, title, count === undefined ? null : h("span", { class: "count" }, String(count))), note ? h("p", { class: "view-note" }, note) : null),
        actions ? h("div", { class: "view-actions" }, actions) : null,
    );

// ---- skeletons ----------------------------------------------------------------------------------------------------
export const skeletonRows = (count = 6) =>
    Array.from({ length: count }, (_, i) => h("div", { class: "row skeleton", "aria-hidden": "true" }, h("span", { class: "sk sk-dot" }), h("span", { class: "sk sk-line", style: { width: `${38 + ((i * 17) % 40)}%` } })));

export const skeletonBoard = () =>
    h(
        "div",
        { class: "board", "aria-hidden": "true" },
        [3, 2, 1].map((cards) =>
            h("div", { class: "lane" }, h("div", { class: "lane-head" }, h("span", { class: "sk sk-line short" })), h("div", { class: "lane-body" }, Array.from({ length: cards }, () => h("div", { class: "card skeleton" }, h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line short" }))))),
        ),
    );

export const skeletonBlock = (lines = 5) => h("div", { class: "skeleton-block", "aria-hidden": "true" }, Array.from({ length: lines }, (_, i) => h("span", { class: "sk sk-line", style: { width: `${i === lines - 1 ? 46 : 78 + ((i * 11) % 22)}%` } })));

// ---- loading ------------------------------------------------------------------------------------------------------
// Re-rendering replaces the control that was clicked (Try again, Load more), which would drop keyboard focus on <body>.
function settleFocus(container, hadFocus) {
    if (!hadFocus) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = container.querySelector(".row-main, .card-main, .btn, a[href], input, select");
    if (target) target.focus();
    else {
        container.tabIndex = -1;
        container.focus();
    }
}

/**
 * Loads data into `container`: skeleton, then content, or an error with a retry. A newer load or `dispose()` makes an
 * older response harmless.
 */
export function section(container, { load, render, skeleton = () => skeletonRows(6), title }) {
    let serial = 0;
    let disposed = false;
    const run = async () => {
        const mine = ++serial;
        const hadFocus = container.contains(document.activeElement);
        container.setAttribute("aria-busy", "true");
        setChildren(container, skeleton());
        try {
            const data = await track(load());
            if (disposed || mine !== serial) return;
            container.removeAttribute("aria-busy");
            setChildren(container, render(data));
        } catch (error) {
            if (disposed || mine !== serial) return;
            container.removeAttribute("aria-busy");
            setChildren(container, errorBox(error, run, title));
        }
        settleFocus(container, hadFocus);
    };
    run();
    return {
        reload: run,
        dispose() {
            disposed = true;
            serial++;
        },
    };
}

/** Arrow keys, Home and End move between rows and cards; Tab still reaches every control. */
export function listKeys(root) {
    root.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        const current = event.target.closest?.(".row-main, .card-main");
        if (!current) return;
        const items = [...root.querySelectorAll(".row-main, .card-main")];
        const at = items.indexOf(current);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
        if (next === at || !items[next]) return;
        event.preventDefault();
        items[next].focus();
    });
}

/**
 * A cursor-paged list: skeleton, rows, a "Load more" footer, and errors (full-page for the first page, inline for later ones).
 * `load(cursor)` resolves to `{ items, nextCursor }`; `info(data)` renders a line above the list for the first page.
 */
export function pager(container, { load, renderItem, empty, info, label = "Results", noun = "item" }) {
    let serial = 0;
    let disposed = false;
    let cursor = null;
    let loaded = 0;
    let busy = false;
    const infoSlot = h("div", { class: "list-info" });
    const list = h("div", { class: "list", role: "list", "aria-label": label });
    const footer = h("div", { class: "list-footer" });
    listKeys(list);

    function renderFooter({ error, loading } = {}) {
        const count = h("span", { class: "muted tnum" }, cursor ? `${loaded} loaded` : plural(loaded, noun));
        if (error) {
            setChildren(footer, h("div", { class: "banner error", role: "alert" }, icon("alert", { size: 14 }), h("span", {}, `Could not load more: ${error.message}`), linkButton("Try again", (event) => loadMore(event.currentTarget))));
        } else if (cursor) {
            setChildren(footer, count, h("button", { class: "btn", type: "button", disabled: loading, onclick: (event) => loadMore(event.currentTarget) }, loading ? "Loading…" : "Load more"));
        } else setChildren(footer, count);
    }

    async function loadMore(trigger) {
        if (!cursor || busy) return;
        const mine = serial;
        const hadFocus = document.activeElement === trigger;
        busy = true;
        renderFooter({ loading: true });
        try {
            const data = await track(load(cursor));
            if (disposed || mine !== serial) return;
            const before = list.children.length;
            list.append(...data.items.map(renderItem));
            loaded += data.items.length;
            cursor = data.nextCursor ?? null;
            busy = false;
            renderFooter();
            if (hadFocus) (list.children[before]?.querySelector(".row-main") ?? footer.querySelector("button"))?.focus();
        } catch (error) {
            if (disposed || mine !== serial) return;
            busy = false;
            renderFooter({ error });
            if (hadFocus) footer.querySelector("button")?.focus();
        }
    }

    async function loadFirst() {
        const mine = ++serial;
        cursor = null;
        loaded = 0;
        busy = false;
        const hadFocus = container.contains(document.activeElement);
        container.setAttribute("aria-busy", "true");
        setChildren(infoSlot);
        setChildren(container, infoSlot, h("div", { class: "list", "aria-hidden": "true" }, skeletonRows(6)));
        try {
            const data = await track(load(null));
            if (disposed || mine !== serial) return;
            container.removeAttribute("aria-busy");
            setChildren(infoSlot, info?.(data));
            if (!data.items.length) setChildren(container, infoSlot, empty(data));
            else {
                setChildren(list, data.items.map(renderItem));
                loaded = data.items.length;
                cursor = data.nextCursor ?? null;
                renderFooter();
                setChildren(container, infoSlot, list, footer);
            }
        } catch (error) {
            if (disposed || mine !== serial) return;
            container.removeAttribute("aria-busy");
            setChildren(container, infoSlot, errorBox(error, loadFirst));
        }
        settleFocus(container, hadFocus);
    }

    loadFirst();
    return {
        reload: loadFirst,
        dispose() {
            disposed = true;
            serial++;
        },
    };
}

// ---- work item pieces ---------------------------------------------------------------------------------------------
export const statusPill = (status) => h("span", { class: `pill s-${status?.category ?? "todo"}`, title: `Status: ${status?.name ?? "Unknown"}` }, h("span", { class: "pill-text" }, status?.name ?? "Unknown"));

export function dueBadge(issue) {
    if (!issue.due) return null;
    const status = dueStatus(issue.due, issue.status?.category);
    const title = status === "overdue" ? `Overdue: due ${issue.due}` : `Due ${issue.due}`;
    return h("span", { class: `meta-chip due ${status}`.trim(), title }, icon("calendar", { size: 12 }), h("span", { class: "tnum" }, dayLabel(issue.due)));
}

export function labelChips(labels, max = 3) {
    const rest = labels.slice(max);
    return [...labels.slice(0, max).map(labelChip), rest.length ? h("span", { class: "chip more", title: rest.join(", ") }, `+${rest.length}`) : null];
}

function sessionButton(issue, cls) {
    if (!state.capabilities.openSession) return null;
    const label = `New Copilot session from ${issue.key}`;
    return h("div", { class: cls }, h("button", { class: "icon-btn", type: "button", title: label, "aria-label": label, onclick: () => openLaunch(issue.key) }, icon("session", { size: 14 })));
}

const assigneeAvatar = (issue) => avatar(issue.assignee, 20, issue.assignee ? `Assignee: ${issue.assignee.name}` : "Unassigned");

export function issueRow(issue) {
    const selected = state.view.issue === issue.key;
    return h(
        "div",
        { class: `row${selected ? " selected" : ""}`, role: "listitem", dataset: { key: issue.key } },
        h(
            "button",
            { class: "row-main", type: "button", "aria-current": selected ? "true" : null, onclick: (event) => openIssue(issue.key, { fromKeyboard: event.detail === 0 }) },
            typeBadge(issue.type),
            h("span", { class: "row-key tnum" }, issue.key),
            h("span", { class: "row-summary" }, issue.summary || "(no summary)"),
            h(
                "span",
                { class: "row-meta" },
                h("span", { class: "row-labels" }, labelChips(issue.labels ?? [], 2)),
                priorityIcon(issue.priority),
                dueBadge(issue),
                statusPill(issue.status),
                assigneeAvatar(issue),
                h("span", { class: "row-updated tnum", title: fullTime(issue.updated) }, relTime(issue.updated)),
            ),
        ),
        sessionButton(issue, "row-actions"),
    );
}

export function issueCard(issue) {
    const selected = state.view.issue === issue.key;
    return h(
        "div",
        { class: `card${selected ? " selected" : ""}`, role: "listitem", dataset: { key: issue.key } },
        h(
            "button",
            { class: "card-main", type: "button", "aria-current": selected ? "true" : null, onclick: (event) => openIssue(issue.key, { fromKeyboard: event.detail === 0 }) },
            h("span", { class: "card-summary" }, issue.summary || "(no summary)"),
            issue.labels?.length ? h("span", { class: "card-labels" }, labelChips(issue.labels, 3)) : null,
            h("span", { class: "card-foot" }, typeBadge(issue.type), h("span", { class: "row-key tnum" }, issue.key), priorityIcon(issue.priority), dueBadge(issue), h("span", { class: "spacer" }), assigneeAvatar(issue)),
        ),
        sessionButton(issue, "card-actions"),
    );
}

/** Highlights the row or card of the open work item without rebuilding the list. */
export function markSelected(root, key) {
    for (const el of root.querySelectorAll("[data-key]")) {
        const on = Boolean(key) && el.dataset.key === key;
        el.classList.toggle("selected", on);
        const main = el.querySelector(".row-main, .card-main");
        if (on) main?.setAttribute("aria-current", "true");
        else main?.removeAttribute("aria-current");
    }
}
