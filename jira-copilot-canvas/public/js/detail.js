// The drawer: the open work item (Jira) or page (Confluence), including the inline "New Copilot session" panel.
import { api } from "./api.js";
import { avatar, copyText, fullTime, h, icon, labelChip, priorityIcon, relTime, setChildren, typeBadge, userChip } from "./dom.js";
import { mountLaunch } from "./launch.js";
import { renderMarkdown } from "./md.js";
import { button, dueBadge, errorBox, linkButton, skeletonBlock, statusPill } from "./parts.js";
import { closeDetail, drawerTarget, isIssueKey, notifyError, on, openIssue, setView, siteInfo, state, track } from "./state.js";

const FOCUSABLE = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";
let sequence = 0;

const baseUrl = () => siteInfo()?.url?.replace(/\/+$/, "") ?? "";
const spaceOf = (key) => key.slice(0, key.lastIndexOf("-"));
const time = (iso) => (relTime(iso) ? h("time", { datetime: iso, title: fullTime(iso) }, relTime(iso)) : null);
const chips = (values) => (values?.length ? h("span", { class: "chips" }, values.map(labelChip)) : null);
const focusKey = (node) => node.dataset?.focusKey ?? node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "";

function setLink(anchor, url) {
    const ok = /^https?:\/\//i.test(url ?? "");
    if (ok) anchor.setAttribute("href", url);
    else anchor.removeAttribute("href");
    anchor.hidden = !ok;
}

function section(title, count, ...content) {
    return h("section", { class: "detail-section" }, h("h3", { class: "detail-section-title" }, title, count ? h("span", { class: "count" }, String(count)) : null), content);
}

function fieldList(rows) {
    const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
    return shown.length ? h("dl", { class: "fields" }, shown.map(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])) : null;
}

const relatedRow = (item, go) =>
    h(
        "li",
        {},
        h(
            "button",
            { class: "related-btn", type: "button", dataset: { focusKey: `open-${item.key}` }, onclick: () => go(item.key) },
            typeBadge({ name: item.type }),
            h("span", { class: "row-key tnum" }, item.key),
            h("span", { class: "related-summary" }, item.summary || "(no summary)"),
            statusPill(item.status),
        ),
    );

function subtasksSection(subtasks, go) {
    if (!subtasks?.length) return null;
    return section("Subtasks", subtasks.length, h("ul", { class: "related" }, subtasks.map((item) => relatedRow(item, go))));
}

function linkedSection(links, go) {
    if (!links?.length) return null;
    const groups = new Map();
    for (const link of links) {
        const label = link.label || link.type || "Linked";
        groups.set(label, [...(groups.get(label) ?? []), link.issue]);
    }
    const groupViews = [...groups].map(([label, items]) =>
        h("div", { class: "related-group" }, h("h4", { class: "related-label" }, label.charAt(0).toUpperCase() + label.slice(1)), h("ul", { class: "related" }, items.map((item) => relatedRow(item, go)))),
    );
    return section("Linked work items", links.length, groupViews);
}

function commentView(comment, markdown) {
    return h(
        "article",
        { class: "comment", tabindex: "-1" },
        h(
            "header",
            { class: "comment-head" },
            avatar(comment.author, 22),
            h("strong", { class: "comment-author" }, comment.author?.name || "Unknown user"),
            comment.internal ? h("span", { class: "chip internal", title: "An internal note: the customer does not see it" }, "Internal") : null,
            h("span", { class: "comment-time muted" }, time(comment.created)),
        ),
        h("div", { class: "comment-body" }, comment.body?.trim() ? markdown(comment.body) : h("p", { class: "muted" }, "(empty comment)")),
    );
}

/** The comments of a work item: the first page arrives with it, "Load more" fetches the rest. */
function commentsSection(issue, markdown) {
    const data = issue.comments ?? { items: [], total: 0, nextStart: null, error: null };
    const heading = h("h3", { class: "detail-section-title" });
    const list = h("div", { class: "comments" });
    const footer = h("div", { class: "list-footer" });
    const el = h("section", { class: "detail-section" }, heading, list, footer);
    const more = button("Load more comments", () => fetchMore());
    let failure = data.error ?? null;
    let busy = false;

    function paint() {
        setChildren(heading, "Comments", data.total ? h("span", { class: "count" }, String(data.total)) : null);
        setChildren(list, data.items.map((comment) => commentView(comment, markdown)));
        const hasMore = data.nextStart !== null && data.nextStart !== undefined;
        more.textContent = busy ? "Loading…" : "Load more comments";
        more.setAttribute("aria-disabled", String(busy));
        setChildren(
            footer,
            failure ? h("div", { class: "banner error", role: "alert" }, icon("alert", { size: 14 }), h("span", {}, `Could not load comments: ${failure}`), linkButton("Try again", () => fetchMore())) : null,
            hasMore && !failure ? more : null,
            !data.items.length && !failure ? h("p", { class: "muted" }, "No comments yet.") : null,
        );
    }

    async function fetchMore() {
        if (busy) return;
        const restart = data.nextStart === null || data.nextStart === undefined;
        const hadFocus = footer.contains(document.activeElement);
        busy = true;
        failure = null;
        paint();
        try {
            const page = await track(api.comments(issue.key, restart ? 0 : data.nextStart));
            if (!el.isConnected) return;
            const before = restart ? 0 : data.items.length;
            data.items = restart ? page.items : [...data.items, ...page.items];
            data.total = page.total ?? data.items.length;
            data.nextStart = page.nextStart ?? null;
            busy = false;
            paint();
            if (hadFocus && !footer.contains(document.activeElement)) (list.children[before] ?? footer.querySelector("button"))?.focus();
        } catch (error) {
            busy = false;
            if (!el.isConnected) return;
            failure = error?.message ?? "Unknown error";
            paint();
            if (hadFocus) footer.querySelector("button")?.focus();
        }
    }

    paint();
    return el;
}

export function mountDetail(root, { content = null } = {}) {
    const overlay = window.matchMedia("(max-width: 760px)");
    let shell = null;
    let trail = [];
    let expected = "";

    // Below this width the drawer covers the list, so the list must not stay reachable by keyboard behind it.
    const syncInert = () => {
        if (content) content.inert = overlay.matches && !root.hidden;
    };
    const metaSig = () => `${baseUrl()}|${state.spaceKeys.size}`;

    // ---- navigation inside the drawer ---------------------------------------------------------------------------
    function go(key) {
        const here = shell?.kind === "issue" ? shell.id : "";
        if (!key || key === here) return;
        if (here) trail.push(here);
        expected = `issue:${key}`;
        openIssue(key);
        expected = "";
    }

    function back() {
        const previous = trail.pop();
        if (!previous) return;
        expected = `issue:${previous}`;
        setView({ issue: previous });
        expected = "";
    }

    // A key found in a Confluence page opens that work item in Jira.
    const jump = (key) => setView({ domain: "jira", space: spaceOf(key), tab: "issues", issue: key, page: null });

    // ---- the "New Copilot session" panel ------------------------------------------------------------------------
    function openPanel(mine) {
        if (shell !== mine || mine.kind !== "issue" || mine.status !== "ready" || !state.capabilities.openSession) return;
        if (!mine.launch) {
            mine.launch = mountLaunch(mine.launchSlot, { key: mine.id, onClose: () => closePanel(mine) });
            mine.launchSlot.hidden = false;
            mine.launchButton?.setAttribute("aria-expanded", "true");
        }
        mine.launch.focus();
        mine.launchSlot.scrollIntoView({ block: "nearest" });
    }

    function closePanel(mine) {
        if (!mine.launch) return;
        const hadFocus = mine.launchSlot.contains(document.activeElement) || document.activeElement === document.body;
        mine.launch.dispose();
        mine.launch = null;
        mine.launchSlot.hidden = true;
        mine.launchButton?.setAttribute("aria-expanded", "false");
        if (shell === mine && hadFocus) mine.launchButton?.focus({ preventScroll: true });
    }

    // ---- content ------------------------------------------------------------------------------------------------
    function issueView(mine) {
        const issue = mine.data;
        const own = spaceOf(issue.key);
        const markdown = (source) => renderMarkdown(source, { onRef: go, isRef: (key) => isIssueKey(key, own), base: `${baseUrl()}/` });
        const parent = issue.parent;
        mine.launchButton = state.capabilities.openSession
            ? h(
                  "button",
                  { class: "btn primary", type: "button", "aria-expanded": String(Boolean(mine.launch)), "aria-controls": mine.launchSlot.id, dataset: { focusKey: "launch" }, onclick: () => (mine.launch ? closePanel(mine) : openPanel(mine)) },
                  icon("session", { size: 14 }),
                  "New Copilot session",
              )
            : null;
        mine.launchSlot.hidden = !mine.launch;
        return [
            h("h2", { class: "detail-title" }, issue.summary || "(no summary)"),
            h("div", { class: "detail-chips" }, statusPill(issue.status), issue.priority ? h("span", { class: "meta-chip" }, priorityIcon(issue.priority, { size: 13 }), h("span", { "aria-hidden": "true" }, issue.priority.name)) : null, dueBadge(issue)),
            mine.launchButton ? h("div", { class: "detail-actions" }, mine.launchButton) : null,
            mine.launchSlot,
            fieldList([
                ["Assignee", userChip(issue.assignee)],
                ["Reporter", issue.reporter ? userChip(issue.reporter) : null],
                ["Parent", parent ? h("button", { class: "link-btn parent-link", type: "button", title: parent.summary, dataset: { focusKey: `open-${parent.key}` }, onclick: () => go(parent.key) }, h("span", { class: "row-key tnum" }, parent.key), parent.summary) : null],
                ["Labels", chips(issue.labels)],
                ["Components", chips(issue.components)],
                ["Fix versions", chips(issue.fixVersions)],
                ["Resolution", issue.resolution],
                ["Created", time(issue.created)],
                ["Updated", time(issue.updated)],
            ]),
            section("Description", 0, issue.description?.trim() ? markdown(issue.description) : h("p", { class: "muted" }, "No description.")),
            subtasksSection(issue.subtasks, go),
            linkedSection(issue.links, go),
            commentsSection(issue, markdown),
        ];
    }

    function pageView(mine) {
        const page = mine.data;
        const spaceName = page.space?.name || page.space?.key;
        return [
            h("h2", { class: "detail-title" }, page.title || "(untitled)"),
            h("div", { class: "detail-chips" }, spaceName ? h("span", { class: "chip", title: `Confluence space: ${spaceName}` }, spaceName) : null, page.author ? userChip(page.author, 16) : null, page.modified ? h("span", { class: "muted" }, "Updated ", time(page.modified)) : null),
            page.body?.trim()
                ? renderMarkdown(page.body, { onRef: jump, isRef: (key) => isIssueKey(key), base: `${baseUrl()}/` })
                : h("p", { class: "muted" }, "Nothing to show here. The page may only contain content that cannot be displayed; open it in Confluence to see everything."),
        ];
    }

    function paintHead(mine) {
        if (mine.kind === "issue") {
            const { type, key, url } = mine.data;
            setChildren(mine.ident, typeBadge(type), h("span", { class: "detail-kind" }, type?.name || "Work item"), h("span", { class: "detail-id tnum" }, key));
            setLink(mine.external, url || `${baseUrl()}/browse/${key}`);
            return;
        }
        const page = mine.data;
        setChildren(mine.ident, icon("page", { size: 14 }), h("span", { class: "detail-kind" }, page.type === "blogpost" ? "Blog post" : "Page"));
        setLink(mine.external, page.url);
        mine.copyValue = page.url ?? "";
        mine.copy.disabled = !mine.copyValue;
    }

    function snapshotFocus(mine) {
        const el = document.activeElement;
        return el && el !== mine.body && mine.body.contains(el) ? { el, key: focusKey(el) } : null;
    }

    // Repainting replaces the control that had focus; the same control (by its key) gets it back, else the drawer does.
    function restoreFocus(held) {
        if (!held || document.activeElement === held.el) return;
        if (held.el.isConnected) {
            held.el.focus({ preventScroll: true });
            return;
        }
        const match = [...root.querySelectorAll(FOCUSABLE)].find((node) => focusKey(node) === held.key);
        (match ?? root).focus({ preventScroll: true });
    }

    function paint(mine, { silent = false } = {}) {
        const held = silent ? snapshotFocus(mine) : null;
        paintHead(mine);
        setChildren(mine.body, mine.kind === "issue" ? issueView(mine) : pageView(mine));
        mine.metaSig = metaSig();
        restoreFocus(held);
        if (mine.kind === "issue" && state.launchFor === mine.id) {
            state.launchFor = "";
            openPanel(mine);
        }
    }

    async function load(mine, { silent = false } = {}) {
        const ticket = ++mine.serial;
        if (!silent) {
            mine.status = "loading";
            mine.body.setAttribute("aria-busy", "true");
            setChildren(mine.body, skeletonBlock(6));
        }
        try {
            const data = await track(mine.kind === "page" ? api.confluencePage(mine.id) : api.issue(mine.id));
            if (shell !== mine || ticket !== mine.serial) return;
            mine.data = data;
            mine.status = "ready";
            mine.body.removeAttribute("aria-busy");
            paint(mine, { silent });
        } catch (error) {
            if (shell !== mine || ticket !== mine.serial) return;
            mine.body.removeAttribute("aria-busy");
            if (silent) {
                notifyError(error);
                return;
            }
            mine.status = "error";
            setChildren(mine.body, errorBox(error, () => load(mine), mine.kind === "page" ? "Could not load the page" : `Could not load ${mine.id}`));
        }
    }

    // ---- shell: the header is known from the key, so it shows at once while the content loads --------------------
    function build(target, sig) {
        const isIssue = target.kind === "issue";
        const mine = {
            kind: target.kind,
            id: target.id,
            sig,
            status: "loading",
            data: null,
            serial: 0,
            launch: null,
            launchButton: null,
            launchSlot: h("div", { class: "launch-slot", id: `launch-slot-${++sequence}`, hidden: true }),
            copyValue: isIssue ? target.id : "",
            metaSig: "",
        };
        mine.ident = h("span", { class: "detail-ident" });
        mine.copy = h(
            "button",
            { class: "icon-btn", type: "button", title: isIssue ? "Copy key" : "Copy link", "aria-label": isIssue ? "Copy key" : "Copy link", disabled: !isIssue, onclick: () => copyText(mine.copyValue, isIssue ? "Copied" : "Link copied") },
            icon("copy", { size: 15 }),
        );
        mine.external = h("a", { class: "icon-btn", target: "_blank", rel: "noopener noreferrer", title: isIssue ? "Open in Jira" : "Open in Confluence", "aria-label": isIssue ? "Open in Jira" : "Open in Confluence", hidden: true }, icon("external", { size: 15 }));
        mine.body = h("div", { class: "detail-body" });
        const backButton = h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back to the previous work item", hidden: !isIssue || trail.length === 0, onclick: back }, icon("back", { size: 15 }));
        const close = h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", "aria-label": "Close details", onclick: () => closeDetail() }, icon("x", { size: 15 }));
        setChildren(root, h("header", { class: "detail-head" }, backButton, mine.ident, h("span", { class: "spacer" }), mine.copy, mine.external, close), mine.body);
        root.setAttribute("aria-label", isIssue ? "Work item details" : "Page details");
        if (isIssue) {
            setChildren(mine.ident, typeBadge({ name: "Work item" }), h("span", { class: "detail-kind" }, "Work item"), h("span", { class: "detail-id tnum" }, target.id));
            setLink(mine.external, `${baseUrl()}/browse/${target.id}`);
        } else setChildren(mine.ident, icon("page", { size: 14 }), h("span", { class: "detail-kind" }, "Page"));
        return mine;
    }

    // ---- showing and hiding -------------------------------------------------------------------------------------
    function open(target, sig) {
        const navigated = sig === expected;
        if (!navigated) trail = [];
        expected = "";
        if (target.kind !== "issue" || state.launchFor !== target.id) state.launchFor = "";
        const focusIn = navigated || state.focusDetail;
        state.focusDetail = false;
        shell?.launch?.dispose();
        shell = build(target, sig);
        root.hidden = false;
        syncInert();
        if (focusIn) root.focus({ preventScroll: true });
        load(shell);
    }

    // Hiding the drawer while it holds focus would drop focus on <body>, so the row of the work item gets it back instead.
    // Only when this document is focused: calling focus() from an unfocused iframe would pull focus away from the host app.
    function close() {
        const closing = shell;
        const handBack = closing !== null && document.hasFocus() && (root.contains(document.activeElement) || document.activeElement === document.body);
        closing?.launch?.dispose();
        shell = null;
        trail = [];
        expected = "";
        state.launchFor = "";
        root.hidden = true;
        root.replaceChildren();
        syncInert();
        if (handBack) (content?.querySelector(`[data-key="${CSS.escape(closing.id)}"] :is(.row-main, .card-main)`) ?? content)?.focus({ preventScroll: true });
    }

    function sync() {
        const target = state.phase === "ready" ? drawerTarget() : null;
        const sig = target ? `${target.kind}:${target.id}` : "";
        if (sig === (shell?.sig ?? "")) return;
        if (target) open(target, sig);
        else close();
    }

    const stops = [
        on("view", sync),
        on("phase", sync),
        on("refresh", () => {
            if (shell) load(shell, { silent: shell.status === "ready" });
        }),
        on("launch", ({ key }) => {
            if (shell?.sig !== `issue:${key}` || shell.status !== "ready") return;
            state.launchFor = "";
            state.focusDetail = false;
            openPanel(shell);
        }),
        // Spaces and the site address arrive after the first paint; they decide which keys become links.
        on("meta", () => {
            if (shell?.status === "ready" && shell.metaSig !== metaSig()) paint(shell, { silent: true });
        }),
    ];
    overlay.addEventListener("change", syncInert);
    root.hidden = true;
    sync();

    return {
        dispose() {
            for (const stop of stops) stop();
            overlay.removeEventListener("change", syncInert);
            shell?.launch?.dispose();
            shell = null;
        },
    };
}
