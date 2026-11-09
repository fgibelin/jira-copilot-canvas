// Entry point: boots the store, mounts the regions and keeps the content in step with the view. The toolbar and the
// drawer follow the store on their own; this module decides which view fills the content area and routes shortcuts.
import { authorized } from "./api.js";
import { mountBoard } from "./board.js";
import { mountConfluence, mountSpacePages } from "./confluence.js";
import { mountDetail } from "./detail.js";
import { h, setChildren } from "./dom.js";
import { mountHome } from "./home.js";
import { mountIssues } from "./issues.js";
import { mountComponents, mountReleases } from "./lists.js";
import { errorBox, markSelected, skeletonRows } from "./parts.js";
import { boot, closeDetail, drawerTarget, on, refreshAll, startLive, state } from "./state.js";
import { mountSummary } from "./summary.js";
import { mountToolbar } from "./toolbar.js";

const toolbarRoot = document.getElementById("toolbar");
const content = document.getElementById("content");
const detailRoot = document.getElementById("detail");

mountToolbar(toolbarRoot);
mountDetail(detailRoot, { content });

const VIEWS = {
    confluence: mountConfluence,
    home: mountHome,
    board: (root) => mountBoard(root),
    backlog: (root) => mountBoard(root, { backlog: true }),
    summary: mountSummary,
    issues: mountIssues,
    releases: mountReleases,
    components: mountComponents,
    pages: mountSpacePages,
};
const SPACE_TABS = new Set(["summary", "board", "backlog", "issues", "releases", "components", "pages"]);
// The first request to Atlassian usually answers within a couple of seconds, and the server sends it once more after 10 s.
// A page that is still empty after this long says so instead of looking stuck.
const SLOW_BOOT_MS = 6000;
const SLOW_BOOT_TEXT = "Still connecting to Atlassian… The first request can take a moment.";
// Changes a mounted view applies to itself; any other change either remounts the view or only concerns the drawer.
const FILTER_KEYS = ["q", "qMode", "status", "assignee", "type", "sort", "cq", "board"];

function contentKind(view) {
    if (view.domain === "confluence") return "confluence";
    if (!view.space) return view.tab === "board" && view.board ? "board" : "home";
    return SPACE_TABS.has(view.tab) ? view.tab : "summary";
}

/** Two views with the same key are the same screen: the mounted view updates itself instead of being rebuilt. */
function mountKey(view, kind) {
    if (kind === "confluence") return `confluence|${view.site}|${view.cspace}`;
    return `${kind}|${view.site}|${view.space}|${kind === "board" && !view.space ? view.board : ""}`;
}

let current = null;
let slowBoot = null;

function teardown() {
    clearTimeout(slowBoot);
    slowBoot = null;
    current?.instance?.dispose?.();
    current = null;
}

function mountContent() {
    const kind = contentKind(state.view);
    const hadFocus = content.contains(document.activeElement) && document.activeElement !== content;
    teardown();

    const root = h("div", { class: "view", dataset: { kind } });
    setChildren(content, root);
    content.classList.toggle("is-board", kind === "board");
    content.scrollTop = 0;

    // `current` is set before the view starts: views change the view state after their first await and rely on `update`.
    const mine = { key: mountKey(state.view, kind), instance: null };
    current = mine;
    try {
        mine.instance = VIEWS[kind](root) ?? null;
    } catch (error) {
        console.error(`the ${kind} view failed to open`, error);
        setChildren(root, errorBox(error, mountContent, "Could not open this view"));
    }
    if (hadFocus) content.focus({ preventScroll: true });
}

function showScreen() {
    teardown();
    content.classList.remove("is-board");
    if (state.phase === "boot") {
        // The status region is on the page long before it has any text, because a screen reader announces text that is added to a live region.
        const hint = h("p", { class: "screen-hint", role: "status" });
        slowBoot = setTimeout(() => setChildren(hint, SLOW_BOOT_TEXT), SLOW_BOOT_MS);
        setChildren(
            content,
            h(
                "div",
                { class: "screen" },
                hint,
                h("div", { "aria-busy": "true" }, h("p", { class: "sr-only" }, "Loading Jira…"), h("div", { class: "list", "aria-hidden": "true" }, skeletonRows(8))),
            ),
        );
    } else {
        const fatal = state.fatal ?? { code: "error", message: "Something went wrong." };
        setChildren(content, h("div", { class: "screen" }, errorBox(fatal, () => boot(), "Could not open Jira")));
    }
}

on("phase", () => {
    const ready = state.phase === "ready";
    toolbarRoot.hidden = !ready;
    if (ready) mountContent();
    else showScreen();
});

on("view", ({ changed = [] } = {}) => {
    if (state.phase !== "ready") return;
    const kind = contentKind(state.view);
    if (current?.key !== mountKey(state.view, kind)) mountContent();
    else if (changed.some((name) => FILTER_KEYS.includes(name))) current.instance?.update?.(changed);
    markSelected(content, drawerTarget()?.id ?? "");
});

// A refresh clears the server's cache, so every view loads again from scratch.
on("refresh", () => {
    if (state.phase === "ready") mountContent();
});

// ---- keyboard -------------------------------------------------------------------------------------------------------
const isTyping = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
        if (isTyping(event.target)) event.target.blur();
        else if (drawerTarget()) closeDetail();
        return;
    }
    if (state.phase !== "ready" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    if (event.key === "/") {
        const search = content.querySelector("[data-search]");
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select?.();
    } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        refreshAll();
    }
});

toolbarRoot.hidden = true;
showScreen();
startLive();
boot();

if (!authorized) console.warn("Jira canvas: opened without an access token.");
