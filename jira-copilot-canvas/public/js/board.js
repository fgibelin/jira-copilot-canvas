// Board and Backlog of a space, or of one board opened on its own.
import { api } from "./api.js";
import { boardKind, h, icon, plural, selectInput, setChildren } from "./dom.js";
import { button, errorBox, issueCard, issueRow, linkButton, listKeys, pager, skeletonBoard, skeletonRows, stateBox } from "./parts.js";
import { noteBoards, noteIssues, setView, state, track } from "./state.js";

export function mountBoard(container, { backlog = false } = {}) {
    const title = h("h2", { class: "view-title" }, backlog ? "Backlog" : "Board");
    const note = h("p", { class: "view-note", hidden: true });
    const actions = h("div", { class: "view-actions" });
    const head = h("div", { class: "view-head" }, h("div", { class: "view-head-text" }, title, note), actions);
    const body = h("div", { class: "board-body" });
    setChildren(container, head, body);

    let disposed = false;
    let boards = [];
    let picker = null;
    let shown = "";
    let inner = null;
    const meta = { loaded: 0, more: false };

    // Updated in place so a keyboard user who just picked a board keeps focus on the picker.
    function renderHead() {
        const board = state.boards.get(shown) ?? null;
        const named = !picker && Boolean(board);
        title.textContent = backlog ? "Backlog" : named ? board.name : "Board";
        const parts = [backlog && named ? board.name : "", board ? boardKind(board.type) : "", meta.loaded ? `${meta.loaded}${meta.more ? "+" : ""} work items` : ""].filter(Boolean);
        note.textContent = parts.join(" · ");
        note.hidden = parts.length === 0;
        if (picker && picker.value !== shown) picker.value = shown;
    }

    function selectBoard(id) {
        if (!id) return;
        if (id === shown) return renderHead();
        shown = id;
        meta.loaded = 0;
        meta.more = false;
        inner?.dispose();
        renderHead();
        inner = backlog ? showBacklog(id) : showLanes(id);
    }

    function showBacklog(id) {
        const holder = h("div", { class: "backlog" });
        setChildren(body, holder);
        return pager(holder, {
            label: "Backlog",
            noun: "work item",
            load: async (cursor) => {
                const data = await api.board(id, { backlog: true, cursor });
                noteBoards([data.board]);
                noteIssues(data.issues);
                meta.loaded = cursor ? meta.loaded + data.issues.length : data.issues.length;
                meta.more = Boolean(data.nextCursor);
                renderHead();
                return { items: data.issues, nextCursor: data.nextCursor, hint: data.hint };
            },
            renderItem: issueRow,
            empty: (data) => {
                const flat = /no backlog|kanban/i.test(data.hint ?? "");
                return stateBox({
                    iconName: "backlog",
                    title: flat ? "This board has no separate backlog" : "The backlog is empty",
                    text: flat ? "Kanban and team-managed boards keep all of their work on the board itself." : data.hint || "Work items that are not in a sprint show up here.",
                    actions: flat ? [button("Open the board", () => setView({ tab: "board" }))] : [],
                });
            },
        });
    }

    function showLanes(id) {
        let serial = 0;
        let dead = false;
        let cursor = null;
        let loading = false;
        let columns = null;
        let lanes = new Map();
        const footer = h("div", { class: "list-footer" });
        const wrap = h("div", { class: "board-wrap", "aria-busy": "true" }, skeletonBoard());
        setChildren(body, wrap);

        const makeLane = (name) => {
            const count = h("span", { class: "count tnum" }, "0");
            const list = h("div", { class: "lane-body", role: "list", "aria-label": name });
            const empty = h("p", { class: "lane-empty" }, "No work items");
            return { el: h("div", { class: "lane", role: "group", "aria-label": name }, h("div", { class: "lane-head" }, h("h3", { class: "lane-title" }, name), count), list, empty), list, count, empty, total: 0 };
        };

        const recount = () => {
            for (const lane of lanes.values()) {
                lane.count.textContent = `${lane.total}${cursor ? "+" : ""}`;
                lane.empty.hidden = lane.total > 0;
            }
        };

        function renderFooter({ error, busy } = {}) {
            if (error) {
                setChildren(footer, h("div", { class: "banner error", role: "alert" }, icon("alert", { size: 14 }), h("span", {}, `Could not load more: ${error.message}`), linkButton("Try again", (event) => more(event.currentTarget))));
            } else if (cursor) {
                setChildren(footer, h("span", { class: "muted tnum" }, `${meta.loaded} loaded`), h("button", { class: "btn", type: "button", disabled: busy, onclick: (event) => more(event.currentTarget) }, busy ? "Loading…" : "Load more"));
            } else setChildren(footer, h("span", { class: "muted tnum" }, plural(meta.loaded, "work item")));
        }

        // Returns the first card it added, so keyboard focus can move onto new content.
        function place(items) {
            let firstCard = null;
            for (const item of items) {
                let lane = lanes.get(item.column);
                if (!lane) {
                    lane = makeLane("Other");
                    lanes.set(item.column, lane);
                    columns.append(lane.el);
                }
                const card = issueCard(item);
                firstCard ??= card;
                lane.list.append(card);
                lane.total++;
            }
            meta.loaded += items.length;
            return firstCard;
        }

        async function first() {
            const mine = ++serial;
            wrap.setAttribute("aria-busy", "true");
            setChildren(wrap, skeletonBoard());
            try {
                const data = await track(api.board(id, {}));
                if (dead || mine !== serial) return;
                wrap.removeAttribute("aria-busy");
                noteBoards([data.board]);
                noteIssues(data.issues);
                if (!data.columns.length) {
                    setChildren(wrap, stateBox({ iconName: "board", title: "This board has no columns yet", text: "Add columns and work items in Jira, then use Refresh." }));
                    return renderHead();
                }
                columns = h("div", { class: "board", role: "group", "aria-label": "Board columns" });
                lanes = new Map(
                    data.columns.map((column) => {
                        const lane = makeLane(column.name);
                        columns.append(lane.el);
                        return [column.index, lane];
                    }),
                );
                listKeys(columns);
                cursor = data.nextCursor;
                meta.loaded = 0;
                place(data.issues);
                meta.more = Boolean(cursor);
                recount();
                renderFooter();
                setChildren(wrap, data.hint ? h("p", { class: "view-note board-hint" }, data.hint) : null, columns, footer);
                renderHead();
            } catch (error) {
                if (dead || mine !== serial) return;
                wrap.removeAttribute("aria-busy");
                setChildren(wrap, errorBox(error, first, "Could not load the board"));
            }
        }

        async function more(trigger) {
            if (!cursor || loading) return;
            const mine = serial;
            const hadFocus = document.activeElement === trigger;
            loading = true;
            renderFooter({ busy: true });
            try {
                const data = await track(api.board(id, { cursor }));
                if (dead || mine !== serial) return;
                noteIssues(data.issues);
                cursor = data.nextCursor;
                const added = place(data.issues);
                meta.more = Boolean(cursor);
                loading = false;
                recount();
                renderFooter();
                renderHead();
                if (hadFocus) (added?.querySelector(".card-main") ?? footer.querySelector("button"))?.focus();
            } catch (error) {
                if (dead || mine !== serial) return;
                loading = false;
                renderFooter({ error });
                if (hadFocus) footer.querySelector("button")?.focus();
            }
        }

        first();
        return {
            dispose() {
                dead = true;
                serial++;
            },
        };
    }

    async function start() {
        const { space, board } = state.view;
        if (!space) {
            selectBoard(board);
            return;
        }
        setChildren(body, backlog ? skeletonRows(6) : skeletonBoard());
        body.setAttribute("aria-busy", "true");
        try {
            const data = await track(api.boards(space));
            if (disposed) return;
            body.removeAttribute("aria-busy");
            boards = data.boards;
            noteBoards(boards);
            if (boards.length > 1) {
                picker = selectInput({ label: "Board", options: boards.map((item) => ({ value: String(item.id), label: item.name })), value: state.view.board || String(boards[0].id), onchange: (id) => setView({ board: id }) });
                actions.append(picker);
            }
            const wanted = state.view.board;
            if (!wanted && !boards.length) {
                setChildren(
                    body,
                    stateBox({ iconName: "board", title: "This space has no board", text: "Boards are created in Jira. Spaces without a board still have work items; use the Work items tab to browse them." }),
                );
                return;
            }
            const id = wanted || String(boards[0].id);
            if (!wanted) setView({ board: id });
            selectBoard(id);
        } catch (error) {
            if (disposed) return;
            body.removeAttribute("aria-busy");
            setChildren(body, errorBox(error, start, "Could not load the boards"));
        }
    }

    start();
    return {
        update(changed) {
            if (!changed.includes("board")) return;
            selectBoard(state.view.board || (boards[0] ? String(boards[0].id) : ""));
        },
        dispose() {
            disposed = true;
            inner?.dispose();
        },
    };
}
