// Tiny DOM toolkit: element builder, inline icons, formatting helpers. Everything is built with DOM APIs and
// text nodes, never HTML strings, so Jira or Confluence content can never become markup.
const SVG_NS = "http://www.w3.org/2000/svg";
const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "hidden", "draggable", "selected", "readOnly", "tabIndex", "multiple", "open", "indeterminate"]);
const SAFE_URL = /^(https?:|mailto:)/i;

export const isSafeUrl = (value) => SAFE_URL.test(String(value ?? ""));

function append(parent, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false || child === true) continue;
        if (Array.isArray(child)) append(parent, child);
        else if (child instanceof Node) parent.append(child);
        else parent.append(document.createTextNode(String(child)));
    }
}

/** h("div", { class: "x", onclick }, "text", childNode, ...) */
export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key === "style" && typeof value === "object") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
        else if ((key === "href" || key === "src") && !isSafeUrl(value)) continue;
        else if (PROPERTY_KEYS.has(key)) el[key] = value;
        else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
}

export const clear = (el) => el.replaceChildren();

/** Replaces all children like replaceChildren(), but skips null/false/undefined the way h() does (the native call would add the text "null"). */
export function setChildren(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
}

// ---- icons (16x16, stroke based) ---------------------------------------------------------------------------------
const dot = (cx, cy) => ["circle", { cx, cy, r: 0.9, fill: "currentColor", stroke: "none" }];
const ICONS = {
    plus: [["path", { d: "M8 3v10M3 8h10" }]],
    x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
    refresh: [["path", { d: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8V6h-3.2" }]],
    search: [["circle", { cx: 7, cy: 7, r: 4.3 }], ["path", { d: "M10.3 10.3L13.5 13.5" }]],
    chevron: [["path", { d: "M4 6.2l4 4 4-4" }]],
    "chevron-right": [["path", { d: "M6.2 4l4 4-4 4" }]],
    check: [["path", { d: "M3.5 8.5l3 3 6-6.5" }]],
    comment: [["path", { d: "M3 3.5h10v7H8.2L5 13v-2.5H3z" }]],
    calendar: [["rect", { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1.6 }], ["path", { d: "M2.5 6.6h11M5.6 2v3M10.4 2v3" }]],
    link: [["path", { d: "M6.6 9.4l2.8-2.8M5.2 8L4 9.2a2.4 2.4 0 0 0 3.4 3.4L8.6 11.4M10.8 8L12 6.8a2.4 2.4 0 0 0-3.4-3.4L7.4 4.6" }]],
    external: [["path", { d: "M9 3h4v4M13 3L7.6 8.4M11 9.6V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.4" }]],
    session: [["rect", { x: 2, y: 2.8, width: 12, height: 10.4, rx: 1.8 }], ["path", { d: "M5.2 6.2L7.2 8l-2 1.8M8.8 10h2.6" }]],
    list: [["path", { d: "M5.6 4h8M5.6 8h8M5.6 12h8" }], dot(2.6, 4), dot(2.6, 8), dot(2.6, 12)],
    board: [["rect", { x: 2.5, y: 3, width: 3, height: 10, rx: 0.8 }], ["rect", { x: 6.5, y: 3, width: 3, height: 6, rx: 0.8 }], ["rect", { x: 10.5, y: 3, width: 3, height: 8, rx: 0.8 }]],
    summary: [["rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.8 }], ["path", { d: "M5.4 10.6V8.4M8 10.6V5.4M10.6 10.6V7.2" }]],
    backlog: [["rect", { x: 2.5, y: 2.8, width: 11, height: 3, rx: 1 }], ["rect", { x: 2.5, y: 7, width: 11, height: 3, rx: 1 }], ["path", { d: "M2.5 12.6h7" }]],
    tag: [["path", { d: "M2.5 8.4V3.4h5l6 6-5 5z" }], dot(5.4, 6.2)],
    person: [["circle", { cx: 8, cy: 5.4, r: 2.5 }], ["path", { d: "M3 13.6c.5-3 2.7-4.4 5-4.4s4.5 1.4 5 4.4" }]],
    release: [["path", { d: "M4 13.6V2.4M4 3h7.4l-1.6 2.6L11.4 8H4" }]],
    component: [["path", { d: "M8 2.2l5.2 2.6v6.4L8 13.8l-5.2-2.6V4.8zM2.8 4.8L8 7.5l5.2-2.7M8 7.5v6.3" }]],
    clock: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.6V8l2.4 1.5" }]],
    alert: [["path", { d: "M8 2.6l6 10.4H2z" }], ["path", { d: "M8 6.6v3M8 11.1h.01" }]],
    info: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 7.2v3.6M8 5.2h.01" }]],
    back: [["path", { d: "M13 8H3.2M7 4L3.2 8 7 12" }]],
    child: [["path", { d: "M4 2.6V10a2 2 0 0 0 2 2h6.4M10 9.5l2.6 2.5-2.6 2.5" }]],
    filter: [["path", { d: "M2.6 3.4h10.8L9.6 8.4v4.2l-3.2-1.6V8.4z" }]],
    task: [["rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }], ["path", { d: "M5.4 8.2l1.8 1.8 3.4-3.7" }]],
    story: [["path", { d: "M4.5 2.5h7v11L8 10.6 4.5 13.5z" }]],
    epic: [["path", { d: "M9.2 2L4.4 9h3.3l-.9 5 4.8-7H8.4z" }]],
    bug: [["path", { d: "M8 5c-2 0-3 1.3-3 3v1.4C5 11.6 6.3 13 8 13s3-1.4 3-3.6V8c0-1.7-1-3-3-3zM6.4 5a1.7 1.7 0 0 1 3.2 0M2.6 8.4H5M11 8.4h2.4M3.4 5.2L5.2 6.6M12.6 5.2l-1.8 1.4M3.4 12l1.9-1.4M12.6 12l-1.9-1.4" }]],
    copy: [["rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6 }], ["path", { d: "M3 10.5V4.6A1.6 1.6 0 0 1 4.6 3h5.9" }]],
    page: [["path", { d: "M4 2.5h5.2l3.3 3.3V13a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" }], ["path", { d: "M9 2.7V6h3.2M5.8 8.6h4.4M5.8 11h4.4" }]],
    folder: [["path", { d: "M2.5 4.5a1 1 0 0 1 1-1h3l1.4 1.6h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" }]],
    "prio-highest": [["path", { d: "M3.8 7.6L8 3.4l4.2 4.2M3.8 12.4L8 8.2l4.2 4.2" }]],
    "prio-high": [["path", { d: "M3.8 10.2L8 6l4.2 4.2" }]],
    "prio-medium": [["path", { d: "M3.2 6h9.6M3.2 10h9.6" }]],
    "prio-low": [["path", { d: "M3.8 5.8L8 10l4.2-4.2" }]],
    "prio-lowest": [["path", { d: "M3.8 3.6L8 7.8l4.2-4.2M3.8 8.4L8 12.6l4.2-4.2" }]],
};

export function icon(name, { size = 16, cls = "" } = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("class", `icon ${cls}`.trim());
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name] ?? []) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        svg.append(node);
    }
    return svg;
}

// ---- Jira vocabulary ----------------------------------------------------------------------------------------------
/** Collapses site-specific issue type names into the few kinds that have their own glyph. */
export function typeKind(type) {
    if (type?.subtask) return "subtask";
    const name = String(type?.name ?? "").toLowerCase();
    if (/epic/.test(name)) return "epic";
    if (/sub-?task/.test(name)) return "subtask";
    if (/story|feature|improvement/.test(name)) return "story";
    if (/bug|defect|incident/.test(name)) return "bug";
    return "task";
}

const TYPE_GLYPH = { epic: "epic", story: "story", bug: "bug", subtask: "child", task: "task" };

export function typeBadge(type, { size = 14 } = {}) {
    const kind = typeKind(type);
    const name = type?.name || "Work item";
    return h("span", { class: `type-ico k-${kind}`, role: "img", "aria-label": name, title: name }, icon(TYPE_GLYPH[kind], { size }));
}

export function priorityLevel(priority) {
    const name = String(priority?.name ?? "").toLowerCase();
    if (!name) return "";
    if (/highest|critical|blocker|urgent/.test(name)) return "highest";
    if (/high|major/.test(name)) return "high";
    if (/lowest|trivial/.test(name)) return "lowest";
    if (/low|minor/.test(name)) return "low";
    return "medium";
}

export function priorityIcon(priority, { size = 14 } = {}) {
    const level = priorityLevel(priority);
    if (!level) return null;
    return h("span", { class: `prio p-${level}`, role: "img", "aria-label": `Priority: ${priority.name}`, title: priority.name }, icon(`prio-${level}`, { size }));
}

const KIND_LABEL = { software: "Software", service_desk: "Service management", business: "Work management" };
const STYLE_LABEL = { "next-gen": "Team-managed", classic: "Company-managed" };
export const spaceKind = (space) => [STYLE_LABEL[space?.style], KIND_LABEL[space?.type]].filter(Boolean).join(" ") || "Space";

export const quoteJql = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---- formatting ---------------------------------------------------------------------------------------------------
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]];

export function relTime(iso, now = Date.now()) {
    const time = Date.parse(iso ?? "");
    if (Number.isNaN(time)) return "";
    const seconds = (time - now) / 1000;
    for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    return "just now";
}

export const fullTime = (iso) => {
    const time = new Date(iso ?? "");
    return Number.isNaN(time.getTime()) ? "" : time.toLocaleString();
};

const parseDay = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

export function dayLabel(ymd) {
    const day = parseDay(ymd);
    if (!day) return "";
    const sameYear = day.getFullYear() === new Date().getFullYear();
    return day.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "overdue" | "soon" (within 2 days) | "" for a YYYY-MM-DD due date; finished work is never overdue. */
export function dueStatus(ymd, category) {
    const day = parseDay(ymd);
    if (!day || category === "done") return "";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((day - today) / 86_400_000);
    return days < 0 ? "overdue" : days <= 2 ? "soon" : "";
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function debounce(fn, ms) {
    let timer;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

// ---- small shared widgets -----------------------------------------------------------------------------------------
function initials(name) {
    const words = String(name || "?").trim().split(/\s+/);
    return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words.at(-1)[0] : "")).toUpperCase();
}

const hueOf = (text) => {
    let hue = 0;
    for (const ch of String(text ?? "")) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    return hue;
};
export { hueOf };

const BOARD_KINDS = { kanban: "Kanban", scrum: "Scrum", simple: "Team-managed" };
export const boardKind = (type) => BOARD_KINDS[String(type ?? "").toLowerCase()] ?? (type ? String(type) : "Board");

/** @param {{ id?: string, name?: string, avatar?: string } | null | undefined} user */
export function avatar(user, size = 20, label = "") {
    if (!user) return h("span", { class: "avatar unassigned", style: { "--size": `${size}px` }, title: "Unassigned", role: "img", "aria-label": label || "Unassigned" }, icon("person", { size: Math.round(size * 0.62) }));
    const name = user.name || "Unknown user";
    const wrap = h("span", { class: "avatar", style: { "--size": `${size}px`, "--hue": hueOf(user.id || user.name) }, title: name, role: "img", "aria-label": label || name }, h("span", { class: "avatar-fallback", "aria-hidden": "true" }, initials(user.name)));
    if (isSafeUrl(user.avatar) && !/^mailto:/i.test(user.avatar)) {
        const img = h("img", { src: user.avatar, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
        img.addEventListener("error", () => img.remove());
        wrap.append(img);
    }
    return wrap;
}

export const userChip = (user, size = 18) => (user ? h("span", { class: "user-chip" }, avatar(user, size), h("span", { class: "user-name" }, user.name || "Unknown user")) : h("span", { class: "muted" }, "Unassigned"));

export function labelChip(text) {
    return h("span", { class: "chip", title: text }, text);
}

export function toast(message, kind = "info", ms = 4500) {
    const host = document.getElementById("toasts");
    if (!host) return;
    const failed = kind === "error";
    const node = h(
        "div",
        { class: `toast ${kind}`, role: failed ? "alert" : null },
        failed ? icon("alert", { size: 14, cls: "toast-icon" }) : null,
        h("span", {}, String(message).slice(0, 400)),
        h("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, icon("x", { size: 12 })),
    );
    host.append(node);
    while (host.children.length > 4) host.firstChild.remove();
    if (ms) setTimeout(() => node.remove(), ms);
}

export async function copyText(text, what = "Copied") {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const area = h("textarea", { readOnly: true, style: { position: "fixed", opacity: "0", top: "0", left: "0" } });
        area.value = text;
        document.body.append(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        area.remove();
        if (!ok) return toast("Could not copy to the clipboard.", "error");
    }
    toast(`${what}: ${text}`, "info", 2200);
}

/** A native <select>. The value is applied after the options exist, which h() cannot do for a property set up front. */
export function selectInput({ label, options, value, onchange, cls = "" }) {
    const el = h("select", { class: `input select ${cls}`.trim(), "aria-label": label, title: label, onchange: (event) => onchange(event.target.value) }, options.map((option) => h("option", { value: option.value }, option.label)));
    el.value = String(value ?? "");
    if (el.value !== String(value ?? "") && options.length) el.selectedIndex = 0;
    return el;
}
