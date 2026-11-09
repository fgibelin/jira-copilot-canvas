// Summary of a space: where the work stands, what needs attention and what changed last.
import { api } from "./api.js";
import { h, icon, plural, quoteJql, spaceKind } from "./dom.js";
import { externalLink, issueRow, linkButton, listKeys, section, skeletonBlock, stateBox, viewHead } from "./parts.js";
import { noteIssues, noteSpaces, noteTypes, showWorkItems, siteInfo, state } from "./state.js";

const STATUS_PARTS = [
    ["todo", "To do"],
    ["inprogress", "In progress"],
    ["done", "Done"],
];

function statusBlock(counts) {
    const percent = Math.round((counts.done / counts.total) * 100);
    const bar = h(
        "div",
        { class: "statusbar", role: "img", "aria-label": STATUS_PARTS.map(([id, name]) => `${name}: ${counts[id]}`).join(", ") },
        STATUS_PARTS.filter(([id]) => counts[id] > 0).map(([id]) => h("span", { class: `seg-fill s-${id}`, style: { "flex-grow": counts[id] } })),
    );
    const legend = h(
        "ul",
        { class: "legend" },
        STATUS_PARTS.map(([id, name]) =>
            h(
                "li",
                {},
                h(
                    "button",
                    { class: "legend-btn", type: "button", disabled: counts[id] === 0, title: `Show the ${name.toLowerCase()} work items`, onclick: () => showWorkItems({ status: id }) },
                    h("span", { class: `legend-dot s-${id}` }),
                    name,
                    h("span", { class: "legend-count tnum" }, counts[id]),
                ),
            ),
        ),
    );
    return h("div", { class: "block" }, h("p", { class: "headline" }, `${plural(counts.total, "work item")}, ${percent}% done`), bar, legend);
}

function attentionBlock(counts) {
    const items = [];
    if (counts.overdue) {
        items.push({ iconName: "calendar", text: `${counts.overdue} overdue`, hint: "Past their due date and not done.", go: () => showWorkItems({ qMode: "jql", q: "duedate < startOfDay() AND statusCategory != Done" }) });
    }
    if (counts.unassigned) {
        items.push({ iconName: "person", text: `${counts.unassigned} unassigned`, hint: "Open work items nobody owns yet.", go: () => showWorkItems({ assignee: "unassigned", status: "open" }) });
    }
    return h(
        "div",
        { class: "block" },
        h("h3", { class: "block-title" }, "Needs attention"),
        items.length
            ? h(
                  "ul",
                  { class: "attention" },
                  items.map((item) =>
                      h(
                          "li",
                          {},
                          h("button", { class: "attention-btn", type: "button", onclick: item.go }, icon(item.iconName, { size: 14 }), h("strong", { class: "tnum" }, item.text), h("span", { class: "muted" }, item.hint), h("span", { class: "spacer" }), icon("chevron-right", { size: 12 })),
                      ),
                  ),
              )
            : h("p", { class: "ok-note" }, icon("check", { size: 14 }), "Nothing is overdue and every open work item has an owner."),
    );
}

function barBlock(title, rows, total, go) {
    if (!rows.length) return null;
    return h(
        "div",
        { class: "block" },
        h("h3", { class: "block-title" }, title),
        h(
            "ul",
            { class: "bars" },
            rows.map((row) => {
                const action = go?.(row.name);
                const name = action ? h("button", { class: "bar-label link-btn", type: "button", title: `Show ${row.name}`, onclick: action }, row.name) : h("span", { class: "bar-label" }, row.name);
                return h(
                    "li",
                    { class: "bar-row" },
                    name,
                    h("span", { class: "bar", "aria-hidden": "true" }, h("span", { class: "bar-fill", style: { width: `${Math.max(2, Math.round((row.count / Math.max(total, 1)) * 100))}%` } })),
                    h("span", { class: "bar-count tnum" }, row.count),
                );
            }),
        ),
    );
}

function recentBlock(items) {
    if (!items.length) return null;
    const list = h("div", { class: "list", role: "list", "aria-label": "Recently updated work items" }, items.map(issueRow));
    listKeys(list);
    return h("div", { class: "block" }, h("div", { class: "block-head" }, h("h3", { class: "block-title" }, "Recently updated"), linkButton("View all work items", () => showWorkItems())), list);
}

function sampleNote(data) {
    if (!data.exact) return `Counts cover the ${data.sampled} most recently updated work items.`;
    if (data.sampled < data.counts.total) return `Breakdowns cover the ${data.sampled} most recently updated work items.`;
    return "";
}

function render(data) {
    const { counts, space } = data;
    noteSpaces([space]);
    noteIssues(data.recent);
    noteTypes(data.byType.map((row) => row.name));
    const site = siteInfo();
    const link = space.url || (site?.url ? `${site.url.replace(/\/+$/, "")}/browse/${encodeURIComponent(space.key)}` : "");
    const kind = spaceKind(space);
    const note = [kind === "Space" ? "" : kind, space.lead ? `Led by ${space.lead.name}` : "", sampleNote(data)].filter(Boolean).join(" · ");
    const head = viewHead(space.name || space.key, { note, actions: link ? externalLink(link, "Open in Jira") : null });
    if (!counts.total) {
        return [head, stateBox({ iconName: "list", title: "No work items in this space yet", text: "Work items created in Jira show up here. Use Refresh after adding some." })];
    }
    return [
        head,
        statusBlock(counts),
        attentionBlock(counts),
        h(
            "div",
            { class: "breakdown" },
            barBlock("By type", data.byType, data.sampled, (name) => () => showWorkItems({ type: name })),
            barBlock("By priority", data.byPriority, data.sampled, (name) => () => showWorkItems({ qMode: "jql", q: name === "None" ? "priority is EMPTY" : `priority = ${quoteJql(name)}` })),
            barBlock("By assignee", data.byAssignee, data.sampled, (name) => (name === "Unassigned" ? () => showWorkItems({ assignee: "unassigned" }) : null)),
        ),
        recentBlock(data.recent),
    ];
}

export function mountSummary(container) {
    const loader = section(container, {
        title: "Could not load the summary",
        skeleton: () => [viewHead("Summary"), skeletonBlock(7)],
        load: () => api.summary(state.view.space),
        render,
    });
    return { dispose: loader.dispose };
}
