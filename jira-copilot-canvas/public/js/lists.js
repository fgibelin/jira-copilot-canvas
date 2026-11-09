// Releases (versions) and components of a space. Picking one lists the work items that belong to it.
import { api } from "./api.js";
import { avatar, dayLabel, dueStatus, h, icon, plural, quoteJql } from "./dom.js";
import { listKeys, section, skeletonRows, stateBox, viewHead } from "./parts.js";
import { showWorkItems, state } from "./state.js";

const tile = (iconName) => h("span", { class: "tile neutral", "aria-hidden": "true" }, icon(iconName, { size: 14 }));

const rowText = (name, description) => h("span", { class: "row-text" }, h("span", { class: "row-summary" }, name), description ? h("span", { class: "row-excerpt" }, description) : null);

const rank = (version) => (version.archived ? 2 : version.released ? 1 : 0);

// Upcoming releases first (soonest on top), then shipped ones (latest on top), archived last.
function byRelevance(a, b) {
    const order = rank(a) - rank(b);
    if (order) return order;
    return rank(a) === 1 ? (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") : (a.releaseDate || "9999").localeCompare(b.releaseDate || "9999");
}

function releaseRow(version) {
    const [label, tone] = version.archived ? ["Archived", "s-todo"] : version.released ? ["Released", "s-done"] : ["Unreleased", "s-inprogress"];
    const due = version.releaseDate ? dueStatus(version.releaseDate, version.released ? "done" : "todo") : "";
    return h(
        "div",
        { class: "row", role: "listitem" },
        h(
            "button",
            { class: "row-main", type: "button", title: `Show the work items in ${version.name}`, onclick: () => showWorkItems({ qMode: "jql", q: `fixVersion = ${quoteJql(version.name)}` }) },
            tile("release"),
            rowText(version.name, version.description),
            h(
                "span",
                { class: "row-meta" },
                version.releaseDate ? h("span", { class: `meta-chip due ${due}`.trim(), title: `${version.released ? "Released" : "Release date"} ${version.releaseDate}` }, icon("calendar", { size: 12 }), h("span", { class: "tnum" }, dayLabel(version.releaseDate))) : null,
                h("span", { class: `pill ${tone}` }, h("span", { class: "pill-text" }, label)),
            ),
        ),
    );
}

function componentRow(component) {
    return h(
        "div",
        { class: "row", role: "listitem" },
        h(
            "button",
            { class: "row-main", type: "button", title: `Show the work items in ${component.name}`, onclick: () => showWorkItems({ qMode: "jql", q: `component = ${quoteJql(component.name)}` }) },
            tile("component"),
            rowText(component.name, component.description),
            h(
                "span",
                { class: "row-meta" },
                component.lead ? h("span", { class: "user-chip", title: `Lead: ${component.lead.name}` }, avatar(component.lead, 18), h("span", { class: "user-name" }, component.lead.name)) : null,
                component.issueCount == null ? null : h("span", { class: "row-updated tnum" }, plural(component.issueCount, "work item")),
            ),
        ),
    );
}

function listOf(label, rows) {
    const list = h("div", { class: "list", role: "list", "aria-label": label }, rows);
    listKeys(list);
    return list;
}

export function mountReleases(container) {
    const loader = section(container, {
        title: "Could not load releases",
        skeleton: () => [viewHead("Releases"), skeletonRows(4)],
        load: () => api.versions(state.view.space),
        render: ({ items }) => {
            if (!items.length) {
                return [viewHead("Releases", { count: 0 }), stateBox({ iconName: "release", title: "No releases yet", text: "Versions you create in Jira show up here with their dates and status. Team-managed spaces may not use versions at all." })];
            }
            return [viewHead("Releases", { count: items.length, note: "Pick a release to list the work items planned for it." }), listOf("Releases", items.slice().sort(byRelevance).map(releaseRow))];
        },
    });
    return { dispose: loader.dispose };
}

export function mountComponents(container) {
    const loader = section(container, {
        title: "Could not load components",
        skeleton: () => [viewHead("Components"), skeletonRows(4)],
        load: () => api.components(state.view.space),
        render: ({ items }) => {
            if (!items.length) {
                return [viewHead("Components", { count: 0 }), stateBox({ iconName: "component", title: "No components yet", text: "Components you define in the space settings in Jira show up here. Team-managed spaces may not use components at all." })];
            }
            return [viewHead("Components", { count: items.length, note: "Pick a component to list its work items." }), listOf("Components", items.slice().sort((a, b) => a.name.localeCompare(b.name)).map(componentRow))];
        },
    });
    return { dispose: loader.dispose };
}
