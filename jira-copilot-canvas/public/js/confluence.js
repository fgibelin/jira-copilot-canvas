// Confluence: spaces, the pages of one space and a global search. The Jira "Pages" tab reuses the page list.
import { api } from "./api.js";
import { debounce, fullTime, h, hueOf, icon, relTime, setChildren } from "./dom.js";
import { button, externalLink, listKeys, pager, section, skeletonRows, stateBox, viewHead } from "./parts.js";
import { noteConfluenceSpaces, openPage, setView, state } from "./state.js";

const initials = (text) => String(text).replace(/^[^A-Za-z0-9]+/, "").slice(0, 2).toUpperCase() || "?";

function pageRow(page) {
    const selected = state.view.page === page.id;
    return h(
        "div",
        { class: `row${selected ? " selected" : ""}`, role: "listitem", dataset: { key: page.id } },
        h(
            "button",
            { class: "row-main", type: "button", "aria-current": selected ? "true" : null, onclick: (event) => openPage(page.id, { fromKeyboard: event.detail === 0 }) },
            h("span", { class: "tile neutral", "aria-hidden": "true" }, icon("page", { size: 14 })),
            h("span", { class: "row-text" }, h("span", { class: "row-summary" }, page.title || "(untitled)"), page.excerpt ? h("span", { class: "row-excerpt" }, page.excerpt) : null),
            h(
                "span",
                { class: "row-meta" },
                page.space?.key ? h("span", { class: "chip", title: page.space.name || page.space.key }, page.space.key) : null,
                page.modified ? h("span", { class: "row-updated tnum", title: fullTime(page.modified) }, relTime(page.modified)) : null,
            ),
        ),
    );
}

function confluenceSpaceRow(space) {
    return h(
        "div",
        { class: "row", role: "listitem" },
        h(
            "button",
            { class: "row-main", type: "button", onclick: () => setView({ cspace: space.key, cq: "" }) },
            h("span", { class: "tile", style: { "--hue": hueOf(space.key) }, "aria-hidden": "true" }, initials(space.name || space.key)),
            h("span", { class: "row-text" }, h("span", { class: "row-summary" }, space.name || space.key), space.description ? h("span", { class: "row-excerpt" }, space.description) : null),
            h("span", { class: "row-key tnum" }, space.key),
            space.type === "personal" ? h("span", { class: "row-meta" }, h("span", { class: "row-kind muted" }, "Personal")) : null,
        ),
    );
}

const listOf = (label, rows) => {
    const list = h("div", { class: "list", role: "list", "aria-label": label }, rows);
    listKeys(list);
    return list;
};

const noSpaces = () =>
    stateBox({
        iconName: "folder",
        title: "No Confluence spaces to show",
        text: "Confluence may not be enabled on this site, or the signed-in account cannot see any space yet. Spaces in Jira and Confluence are separate things.",
    });

export function mountConfluence(container) {
    const search = h("input", { class: "input search", type: "search", maxlength: "200", autocomplete: "off", spellcheck: "false", placeholder: "Search all Confluence spaces", "aria-label": "Search Confluence", dataset: { search: "" } });
    const headSlot = h("div", { class: "head-slot" });
    const body = h("div", { class: "confluence-body" });
    setChildren(container, headSlot, h("div", { class: "filters", role: "search" }, search), body);

    let mode = "";
    let active = null;
    let typing = false;

    const apply = () => {
        typing = false;
        setView({ cq: search.value.trim() });
    };
    const commit = debounce(apply, 350);
    search.addEventListener("input", () => {
        typing = true;
        commit();
    });
    search.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        commit.cancel();
        apply();
    });

    function showSpaces() {
        setChildren(headSlot, viewHead("Confluence spaces"));
        return section(body, {
            title: "Could not load Confluence spaces",
            skeleton: () => skeletonRows(5),
            load: () => api.confluenceSpaces(),
            render: ({ items, hasMore }) => {
                noteConfluenceSpaces(items);
                setChildren(headSlot, viewHead("Confluence spaces", { count: `${items.length}${hasMore ? "+" : ""}`, note: "Pick a space to browse its pages, or search all of them." }));
                return items.length ? listOf("Confluence spaces", items.map(confluenceSpaceRow)) : noSpaces();
            },
        });
    }

    function showPages() {
        const key = state.view.cspace;
        const head = (name) => setChildren(headSlot, viewHead("Pages", { note: `In ${name}` }));
        head(state.cspaceNames.get(key) ?? key);
        return pager(body, {
            label: "Pages",
            noun: "page",
            load: async (cursor) => {
                const data = await api.confluencePages(key, cursor);
                const name = data.items[0]?.space?.name;
                if (name && !cursor) head(name);
                return data;
            },
            renderItem: pageRow,
            empty: () => stateBox({ iconName: "page", title: "No pages in this space", text: "Pages you create in Confluence show up here. Use Refresh after adding some.", actions: [button("All spaces", () => setView({ cspace: "" }))] }),
        });
    }

    function showSearch() {
        const head = () => setChildren(headSlot, viewHead("Search results", { note: "Across every space the signed-in account can open." }));
        head();
        const results = pager(body, {
            label: "Search results",
            noun: "result",
            load: (cursor) => api.confluenceSearch(state.view.cq, cursor),
            renderItem: pageRow,
            empty: () => stateBox({ iconName: "search", title: "No pages match", text: `Nothing in Confluence matches “${state.view.cq}”. Check the spelling or try fewer words.` }),
        });
        return {
            reload() {
                head();
                results.reload();
            },
            dispose: results.dispose,
        };
    }

    function show() {
        const { cq, cspace } = state.view;
        const next = cq ? "search" : cspace ? "pages" : "spaces";
        if (next === mode) {
            if (next === "search") active.reload();
            return;
        }
        active?.dispose();
        mode = next;
        active = next === "search" ? showSearch() : next === "pages" ? showPages() : showSpaces();
    }

    search.value = state.view.cq;
    show();

    return {
        update(changed) {
            if (!changed.includes("cq")) return;
            if (!typing) search.value = state.view.cq;
            show();
        },
        dispose() {
            commit.cancel();
            active?.dispose();
        },
    };
}

/** The "Pages" tab of a Jira space: the pages of the Confluence space that shares its key. */
export function mountSpacePages(container) {
    const key = state.view.space;
    let inner = null;
    const loader = section(container, {
        title: "Could not load pages",
        skeleton: () => [viewHead("Pages"), skeletonRows(5)],
        load: async () => {
            const spaces = await api.confluenceSpaces();
            noteConfluenceSpaces(spaces.items);
            return spaces.items.find((item) => item.key.toLowerCase() === key.toLowerCase()) ?? null;
        },
        render: (match) => {
            inner?.dispose();
            inner = null;
            if (!match) {
                return [
                    viewHead("Pages"),
                    stateBox({
                        iconName: "page",
                        title: `No Confluence space with the key ${key}`,
                        text: "This tab shows the pages of the Confluence space that shares the key of this Jira space. Confluence spaces are separate from Jira spaces, so there may be none.",
                        actions: [button("Browse Confluence", () => setView({ domain: "confluence" }))],
                    }),
                ];
            }
            const holder = h("div", { class: "confluence-body" });
            inner = pager(holder, {
                label: "Pages",
                noun: "page",
                load: (cursor) => api.confluencePages(match.key, cursor),
                renderItem: pageRow,
                empty: () => stateBox({ iconName: "page", title: "No pages in this space", text: `The Confluence space ${match.name} has no pages yet.` }),
            });
            return [viewHead("Pages", { note: `From the Confluence space ${match.name}`, actions: match.url ? externalLink(match.url, "Open in Confluence") : null }), holder];
        },
    });
    return {
        dispose() {
            inner?.dispose();
            loader.dispose();
        },
    };
}
