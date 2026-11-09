// The top bar: product switch, breadcrumb, live status, refresh and the space's sections. It is built once and kept in
// sync with the view, so a keyboard user's focus survives navigation.
import { h, icon, isSafeUrl, selectInput, setChildren } from "./dom.js";
import { externalUrl, on, refreshAll, setView, siteInfo, state, switchSite } from "./state.js";

const TABS = [
    { id: "summary", label: "Summary", icon: "summary" },
    { id: "board", label: "Board", icon: "board" },
    { id: "backlog", label: "Backlog", icon: "backlog" },
    { id: "issues", label: "Work items", icon: "list" },
    { id: "releases", label: "Releases", icon: "release" },
    { id: "components", label: "Components", icon: "component" },
    { id: "pages", label: "Pages", icon: "page" },
];
const PRODUCTS = [
    { id: "jira", label: "Jira" },
    { id: "confluence", label: "Confluence" },
];
const LIVE = { live: "Live updates are on", connecting: "Connecting to live updates…", reconnecting: "Reconnecting to live updates…", closed: "Live updates are off. Refresh to see changes." };

export function mountToolbar(root) {
    const products = PRODUCTS.map((product) => h("button", { class: "seg-btn", type: "button", dataset: { id: product.id }, onclick: () => setView({ domain: product.id, issue: null, page: null }) }, product.label));
    const crumbs = h("nav", { class: "crumbs", "aria-label": "Breadcrumb" });
    const siteSlot = h("div", { class: "site-slot" });
    const live = h("span", { class: "live-dot", role: "img" });
    const refresh = h("button", { class: "icon-btn", type: "button", title: "Refresh (R)", "aria-label": "Refresh", onclick: () => refreshAll() }, icon("refresh"));
    const external = h("a", { class: "icon-btn", target: "_blank", rel: "noopener noreferrer" }, icon("external"));
    const tabs = h(
        "nav",
        { class: "tabs", "aria-label": "Space sections" },
        TABS.map((tab) => h("button", { class: "tab", type: "button", dataset: { id: tab.id }, onclick: () => setView({ tab: tab.id, issue: null, page: null }) }, icon(tab.icon, { size: 14 }), h("span", {}, tab.label))),
    );
    setChildren(root, h("div", { class: "toolbar-row" }, h("div", { class: "seg", role: "group", "aria-label": "Product" }, products), crumbs, h("span", { class: "spacer" }), siteSlot, live, refresh, external), tabs);

    const crumb = (label, onclick) => h("li", { class: "crumb" }, onclick ? h("button", { class: "crumb-btn", type: "button", onclick }, label) : h("span", { class: "crumb-here", "aria-current": "page" }, label));
    const sep = () => h("li", { class: "crumb-sep", "aria-hidden": "true" }, icon("chevron-right", { size: 12 }));
    const named = (name, key) => [name && name !== key ? name : null, h("span", { class: "crumb-key" }, key)];

    function trail() {
        const v = state.view;
        const top = (here) => (here ? crumb("All spaces") : crumb("All spaces", () => setView(v.domain === "confluence" ? { cspace: null, cq: null, page: null } : { space: null, tab: "summary", board: null, issue: null })));
        if (v.domain === "confluence") {
            if (v.cq) return [top(false), sep(), crumb(`Search: “${v.cq.length > 40 ? `${v.cq.slice(0, 40)}…` : v.cq}”`)];
            return v.cspace ? [top(false), sep(), h("li", { class: "crumb" }, h("span", { class: "crumb-here", "aria-current": "page" }, named(state.cspaceNames.get(v.cspace), v.cspace)))] : [top(true)];
        }
        if (v.space) return [top(false), sep(), h("li", { class: "crumb" }, h("span", { class: "crumb-here", "aria-current": "page" }, named(state.spaceNames.get(v.space), v.space)))];
        const board = v.board ? state.boards.get(v.board) : null;
        if (v.tab === "board" && v.board) return [top(false), sep(), crumb(board?.name ?? `Board ${v.board}`)];
        return [top(true)];
    }

    let siteKey = "";
    function syncSites() {
        const key = state.sites.map((site) => site.cloudId).join("|");
        const selected = siteInfo()?.cloudId ?? "";
        if (state.sites.length < 2) {
            if (siteKey !== "") setChildren(siteSlot);
            siteKey = "";
            return;
        }
        if (key === siteKey) {
            const select = siteSlot.querySelector("select");
            if (select && select.value !== selected) select.value = selected;
            return;
        }
        siteKey = key;
        setChildren(siteSlot, selectInput({ label: "Atlassian site", options: state.sites.map((site) => ({ value: site.cloudId, label: site.name || site.url })), value: selected, onchange: switchSite }));
    }

    function sync() {
        const v = state.view;
        products.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.id === v.domain)));

        const hadFocus = crumbs.contains(document.activeElement);
        setChildren(crumbs, h("ol", { class: "crumb-list" }, trail()));
        if (hadFocus) document.getElementById("content")?.focus({ preventScroll: true });

        const inSpace = v.domain === "jira" && Boolean(v.space);
        tabs.hidden = !inSpace;
        for (const button of tabs.children) {
            if (button.dataset.id === v.tab) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        syncSites();

        const product = v.domain === "confluence" ? "Confluence" : "Jira";
        const url = externalUrl();
        external.hidden = !isSafeUrl(url);
        if (!external.hidden) external.setAttribute("href", url);
        external.title = `Open in ${product}`;
        external.setAttribute("aria-label", `Open in ${product}`);
    }

    function syncStatus() {
        live.dataset.status = state.live;
        live.title = LIVE[state.live] ?? "";
        live.setAttribute("aria-label", LIVE[state.live] ?? "");
        refresh.toggleAttribute("data-busy", state.syncing > 0);
    }

    on("view", sync);
    on("meta", sync);
    on("phase", sync);
    on("status", syncStatus);
    sync();
    syncStatus();
    return { sync };
}
