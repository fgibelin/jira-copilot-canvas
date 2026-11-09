// Work items of a space: text or JQL search, filters and sorting over a cursor-paged list.
import { api } from "./api.js";
import { copyText, debounce, h, icon, quoteJql, selectInput, setChildren } from "./dom.js";
import { button, externalLink, issueRow, pager, stateBox, viewHead } from "./parts.js";
import { noteIssues, setView, siteInfo, state } from "./state.js";

const FILTER_KEYS = ["q", "qMode", "status", "assignee", "type", "sort"];

const STATUS_OPTIONS = [
    { value: "all", label: "Any status" },
    { value: "open", label: "Not done" },
    { value: "todo", label: "To do" },
    { value: "inprogress", label: "In progress" },
    { value: "done", label: "Done" },
];
const SORT_OPTIONS = [
    { value: "updated", label: "Recently updated" },
    { value: "created", label: "Newest first" },
    { value: "priority", label: "Highest priority" },
    { value: "due", label: "Due soonest" },
];
const MODES = [
    ["text", "Text"],
    ["jql", "JQL"],
];
const PLACEHOLDER = { text: "Search work items", jql: 'JQL, for example priority = High AND labels = "backend"' };

const byName = (a, b) => a.label.localeCompare(b.label);

const assigneeOptions = () => [
    { value: "any", label: "Anyone" },
    { value: "me", label: "Assigned to me" },
    { value: "unassigned", label: "Unassigned" },
    ...[...state.people].map(([value, label]) => ({ value, label })).sort(byName),
];
const typeOptions = () => [{ value: "", label: "Any type" }, ...[...state.knownTypes].map((name) => ({ value: name, label: name })).sort(byName)];

const filtersActive = () => {
    const { q, status, assignee, type } = state.view;
    return Boolean(q) || status !== "all" || assignee !== "any" || Boolean(type);
};

/** Rebuilds a select's options in place (so an open picker keeps focus) and only when they actually changed. */
function fill(select, options, value) {
    const list = options.some((option) => option.value === value) ? options : [...options, { value, label: state.people.get(value) ?? value }];
    const signature = list.map((option) => `${option.value}\u0000${option.label}`).join("\n");
    if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        select.replaceChildren(...list.map((option) => h("option", { value: option.value }, option.label)));
    }
    select.value = value;
}

function jqlLine(data) {
    if (!data.jql) return null;
    const base = siteInfo()?.url?.replace(/\/+$/, "");
    return h(
        "div",
        { class: "jql-line" },
        h("span", { class: "muted" }, "JQL"),
        h("code", { class: "jql", title: data.jql }, data.jql),
        h("button", { class: "icon-btn", type: "button", title: "Copy JQL", "aria-label": "Copy JQL", onclick: () => copyText(data.jql, "Copied JQL") }, icon("copy", { size: 14 })),
        base ? externalLink(`${base}/issues/?jql=${encodeURIComponent(data.jql)}`, "Open in Jira") : null,
    );
}

export function mountIssues(container) {
    const search = h("input", { class: "input search", type: "search", maxlength: "500", autocomplete: "off", spellcheck: "false", "aria-label": "Search work items", dataset: { search: "" } });
    const modeButtons = MODES.map(([id, label]) => h("button", { class: "seg-btn", type: "button", "aria-pressed": "false", onclick: () => setMode(id) }, label));
    const statusSelect = selectInput({ label: "Status", options: STATUS_OPTIONS, value: state.view.status, onchange: (value) => setView({ status: value }) });
    const assigneeSelect = selectInput({ label: "Assignee", options: assigneeOptions(), value: state.view.assignee, onchange: (value) => setView({ assignee: value }) });
    const typeSelect = selectInput({ label: "Work item type", options: typeOptions(), value: state.view.type, onchange: (value) => setView({ type: value }) });
    const sortSelect = selectInput({ label: "Sort order", options: SORT_OPTIONS, value: state.view.sort, onchange: (value) => setView({ sort: value }) });
    const clearButton = h("button", { class: "btn ghost small", type: "button", hidden: true, onclick: clear }, icon("x", { size: 12 }), "Clear filters");

    let typing = false;
    const commit = debounce(() => {
        typing = false;
        setView({ q: search.value.trim() });
    }, 320);
    search.addEventListener("input", () => {
        typing = true;
        commit();
    });
    search.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        commit.cancel();
        typing = false;
        setView({ q: search.value.trim() });
    });

    function setMode(mode) {
        const { qMode, q } = state.view;
        if (mode === qMode) return;
        commit.cancel();
        typing = false;
        // A text search carries over as the equivalent JQL; a JQL query has no text form.
        setView({ qMode: mode, q: mode === "jql" && q ? `text ~ ${quoteJql(q)}` : "" });
    }

    function clear() {
        commit.cancel();
        typing = false;
        setView({ q: null, qMode: null, status: null, assignee: null, type: null });
        search.focus();
    }

    function refill() {
        fill(assigneeSelect, assigneeOptions(), state.view.assignee);
        fill(typeSelect, typeOptions(), state.view.type);
    }

    function sync() {
        const { q, qMode, status, sort } = state.view;
        if (!typing) search.value = q;
        search.placeholder = PLACEHOLDER[qMode];
        MODES.forEach(([id], index) => modeButtons[index].setAttribute("aria-pressed", String(qMode === id)));
        statusSelect.value = status;
        sortSelect.value = sort;
        const ordered = qMode === "jql" && /\border\s+by\b/i.test(q);
        sortSelect.disabled = ordered;
        sortSelect.title = ordered ? "The ORDER BY in your query decides the order" : "Sort order";
        refill();
        clearButton.hidden = !filtersActive();
    }

    const holder = h("div", { class: "results" });
    const results = pager(holder, {
        label: "Work items",
        noun: "work item",
        info: jqlLine,
        load: async (cursor) => {
            const { space, q, qMode, status, assignee, type, sort } = state.view;
            const data = await api.issues(space, { q, qMode, status, assignee, type, sort }, cursor);
            if (noteIssues(data.items)) refill();
            return data;
        },
        renderItem: issueRow,
        empty: () =>
            filtersActive()
                ? stateBox({
                      iconName: "search",
                      title: "No work items match",
                      text: state.view.qMode === "jql" ? "The query ran, but nothing matched. Adjust the JQL or the filters." : "Try a different search or fewer filters.",
                      actions: [button("Clear filters", clear)],
                  })
                : stateBox({ iconName: "list", title: "No work items yet", text: "Work items created in Jira show up in this list. Use Refresh after adding some." }),
    });

    const filters = h(
        "div",
        { class: "filters", role: "search" },
        search,
        h("div", { class: "seg", role: "group", "aria-label": "Search mode" }, modeButtons),
        statusSelect,
        assigneeSelect,
        typeSelect,
        sortSelect,
        clearButton,
    );
    setChildren(container, viewHead("Work items"), filters, holder);
    sync();

    return {
        update(changed) {
            sync();
            if (changed.some((key) => FILTER_KEYS.includes(key))) results.reload();
        },
        dispose() {
            commit.cancel();
            results.dispose();
        },
    };
}
