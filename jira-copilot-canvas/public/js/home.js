// The landing view: the site's spaces and boards as dense rows. Picking one opens it.
import { api } from "./api.js";
import { avatar, boardKind, debounce, h, hueOf, icon, setChildren, spaceKind } from "./dom.js";
import { listKeys, section, skeletonRows, stateBox, viewHead } from "./parts.js";
import { noteBoards, noteSpaces, setView, siteInfo } from "./state.js";

const FILTER_FROM = 8;

const hostOf = (url) => {
    try {
        return new URL(url).host;
    } catch {
        return "";
    }
};

const keyTile = (space) => h("span", { class: "tile", style: { "--hue": hueOf(space.key) }, "aria-hidden": "true" }, space.key.slice(0, 2));

function spaceRow(space) {
    return h(
        "div",
        { class: "row", role: "listitem" },
        h(
            "button",
            { class: "row-main", type: "button", onclick: () => setView({ space: space.key, tab: "summary" }) },
            keyTile(space),
            h("span", { class: "row-summary" }, space.name || space.key),
            h("span", { class: "row-key tnum" }, space.key),
            h("span", { class: "row-meta" }, h("span", { class: "row-kind muted" }, spaceKind(space)), space.lead ? h("span", { class: "user-chip" }, avatar(space.lead, 18), h("span", { class: "user-name" }, space.lead.name)) : null),
        ),
    );
}

function boardRow(board) {
    return h(
        "div",
        { class: "row", role: "listitem" },
        h(
            "button",
            { class: "row-main", type: "button", onclick: () => setView({ space: board.space?.key ?? "", tab: "board", board: String(board.id) }) },
            h("span", { class: "tile neutral", "aria-hidden": "true" }, icon("board", { size: 14 })),
            h("span", { class: "row-summary" }, board.name),
            h("span", { class: "row-meta" }, board.space ? h("span", { class: "row-kind muted" }, board.space.name || board.space.key) : null, h("span", { class: "row-kind muted" }, boardKind(board.type))),
        ),
    );
}

function renderSpaces(spaces) {
    noteSpaces(spaces);
    const host = siteInfo();
    const where = hostOf(host?.url);
    if (!spaces.length) {
        return [
            viewHead("Spaces", { count: 0 }),
            stateBox({ iconName: "folder", title: "No spaces to show", text: "Jira spaces you can browse appear here. If you expect to see some, check that the signed-in Atlassian account can open them in Jira, then refresh." }),
        ];
    }
    const list = h("div", { class: "list", role: "list", "aria-label": "Spaces" });
    listKeys(list);
    const none = h("p", { class: "empty-note", hidden: true }, "No space matches your filter.");
    const paint = (query) => {
        const q = query.trim().toLowerCase();
        const shown = q ? spaces.filter((space) => `${space.name} ${space.key}`.toLowerCase().includes(q)) : spaces;
        setChildren(list, shown.map(spaceRow));
        none.hidden = shown.length > 0;
    };
    paint("");
    const filter =
        spaces.length > FILTER_FROM
            ? h("input", { class: "input search", type: "search", placeholder: "Filter spaces", "aria-label": "Filter spaces", autocomplete: "off", spellcheck: "false", dataset: { search: "" }, oninput: debounce((event) => paint(event.target.value), 120) })
            : null;
    return [viewHead("Spaces", { count: spaces.length, note: `${where ? `On ${where}. ` : ""}Pick a space to see its summary, board and work items.`, actions: filter }), list, none];
}

function renderBoards(boards) {
    noteBoards(boards);
    if (!boards.length) return [viewHead("Boards", { count: 0 }), h("p", { class: "empty-note" }, "No boards found. Boards come from Jira Software and team-managed spaces.")];
    const list = h("div", { class: "list", role: "list", "aria-label": "Boards" }, boards.map(boardRow));
    listKeys(list);
    return [viewHead("Boards", { count: boards.length, note: "Open a board directly, including boards that span several spaces." }), list];
}

export function mountHome(container) {
    const spacesBox = h("div", { class: "home-block" });
    const boardsBox = h("div", { class: "home-block" });
    setChildren(container, spacesBox, boardsBox);
    let boardsSection = null;

    // The boards load once the spaces did: when Atlassian is unreachable the user sees a single, actionable error.
    const spacesSection = section(spacesBox, {
        title: "Could not load spaces",
        skeleton: () => [viewHead("Spaces"), skeletonRows(5)],
        load: () => api.spaces(),
        render: (data) => {
            boardsSection ??= section(boardsBox, {
                title: "Could not load boards",
                skeleton: () => [viewHead("Boards"), skeletonRows(2)],
                load: () => api.boards(),
                render: (boards) => renderBoards(boards.boards),
            });
            return renderSpaces(data.spaces);
        },
    });

    return {
        dispose() {
            spacesSection.dispose();
            boardsSection?.dispose();
        },
    };
}
