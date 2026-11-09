// A small, DOM-based Markdown renderer for Jira and Confluence text (descriptions, comments, pages).
// It never builds HTML strings: every piece of user text goes through text nodes, and only http(s)/mailto links are
// ever turned into anchors, so hostile content stays inert.
import { h } from "./dom.js";

const MAX_CHARS = 200_000;
const MAX_INLINE_CHARS = 20_000;
const MAX_DEPTH = 6;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * @param {string} source
 * @param {{ onRef?: (key: string) => void, isRef?: (key: string) => boolean, base?: string | null }} [options]
 *   `onRef` makes work item keys such as KAN-12 clickable (`isRef` narrows which ones); `base` resolves relative links
 *   (the site URL with a trailing slash).
 */
export function renderMarkdown(source, { onRef, isRef, base } = {}) {
    const ctx = { onRef, isRef, base: base ?? null };
    let text = String(source ?? "").replace(/\r\n?/g, "\n");
    const truncated = text.length > MAX_CHARS;
    if (truncated) text = text.slice(0, MAX_CHARS);
    const root = h("div", { class: "md" });
    blocks(text.split("\n"), root, ctx, 0);
    if (truncated) root.append(h("p", { class: "md-note" }, "… content truncated"));
    return root;
}

// ---- blocks -------------------------------------------------------------------------------------------------------
function isTableStart(lines, i) {
    return i + 1 < lines.length && lines[i].includes("|") && lines[i + 1].includes("|") && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1]);
}

const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTableStart(lines, i);

function splitRow(row) {
    const cells = [];
    let cell = "";
    const body = row.trim().replace(/^\|/, "");
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\" && body[i + 1] === "|") {
            cell += "|";
            i++;
        } else if (body[i] === "|") {
            cells.push(cell.trim());
            cell = "";
        } else cell += body[i];
    }
    if (cell.trim() || !/\|\s*$/.test(row)) cells.push(cell.trim());
    return cells;
}

function blocks(lines, parent, ctx, depth) {
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        if (depth > MAX_DEPTH) {
            parent.append(h("p", {}, lines.slice(i).join("\n")));
            return;
        }
        if (/^\s*<!--/.test(line)) {
            while (i < lines.length && !lines[i].includes("-->")) i++;
            i++;
            continue;
        }

        let m = FENCE.exec(line);
        if (m) {
            const mark = m[1][0];
            const closing = new RegExp(`^ {0,3}${mark}{${m[1].length},}\\s*$`);
            const code = [];
            i++;
            while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
            i++;
            parent.append(h("pre", { class: "md-pre" }, h("code", { dataset: m[2] ? { lang: m[2].slice(0, 30) } : {} }, code.join("\n"))));
            continue;
        }

        m = HEADING.exec(line);
        if (m) {
            const level = Math.min(m[1].length, 6);
            const heading = h(`h${level}`, { class: "md-h" });
            inline(m[2], heading, ctx, 0);
            parent.append(heading);
            i++;
            continue;
        }

        if (HR.test(line)) {
            parent.append(h("hr"));
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const quoted = [];
            while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])[1]);
            const quote = h("blockquote");
            blocks(quoted, quote, ctx, depth + 1);
            parent.append(quote);
            continue;
        }

        if (LIST.test(line)) {
            const { items, next } = parseList(lines, i);
            buildList(items, parent, ctx);
            i = next;
            continue;
        }

        if (isTableStart(lines, i)) {
            const head = splitRow(lines[i]);
            const align = splitRow(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
            i += 2;
            const table = h("table", { class: "md-table" });
            const headRow = h("tr");
            head.forEach((cell, c) => {
                const th = h("th", { style: align[c] ? { "text-align": align[c] } : undefined });
                inline(cell, th, ctx, 0);
                headRow.append(th);
            });
            table.append(h("thead", {}, headRow));
            const body = h("tbody");
            while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !FENCE.test(lines[i])) {
                const tr = h("tr");
                const cells = splitRow(lines[i++]);
                for (let c = 0; c < head.length; c++) {
                    const td = h("td", { style: align[c] ? { "text-align": align[c] } : undefined });
                    inline(cells[c] ?? "", td, ctx, 0);
                    tr.append(td);
                }
                body.append(tr);
            }
            table.append(body);
            parent.append(h("div", { class: "md-table-wrap" }, table));
            continue;
        }

        const paragraph = [lines[i++]];
        while (i < lines.length && lines[i].trim() && !startsBlock(lines, i) && !/^\s*<!--/.test(lines[i])) paragraph.push(lines[i++]);
        const p = h("p");
        inline(paragraph.join("\n"), p, ctx, 0);
        parent.append(p);
    }
}

function parseList(lines, start) {
    const items = [];
    let j = start;
    while (j < lines.length) {
        const line = lines[j];
        const m = LIST.exec(line);
        if (m && !HR.test(line)) {
            items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
            j++;
        } else if (!line.trim()) {
            let k = j + 1;
            while (k < lines.length && !lines[k].trim()) k++;
            if (items.length && k < lines.length && (LIST.test(lines[k]) || /^\s{2,}\S/.test(lines[k]))) j = k;
            else break;
        } else if (items.length && /^\s{2,}\S/.test(line) && !isTableStart(lines, j)) {
            items.at(-1).text += `\n${line.trim()}`;
            j++;
        } else break;
    }
    return { items, next: j };
}

function buildList(items, parent, ctx) {
    const stack = [];
    for (const item of items) {
        while (stack.length && item.indent < stack.at(-1).indent) stack.pop();
        let top = stack.at(-1);
        if (!top || item.indent > top.indent) {
            const el = h(item.ordered ? "ol" : "ul", { start: item.ordered && item.start !== 1 ? item.start : undefined });
            (top ? top.lastLi : parent).append(el);
            top = { indent: item.indent, el, lastLi: null };
            stack.push(top);
        }
        const li = h("li");
        const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(item.text);
        if (task) {
            li.className = "task";
            li.append(h("input", { type: "checkbox", disabled: true, checked: task[1] !== " ", "aria-label": task[1] === " " ? "Not done" : "Done" }));
        }
        inline(task ? task[2] : item.text, li, ctx, 0);
        top.el.append(li);
        top.lastLi = li;
    }
}

// ---- inline -------------------------------------------------------------------------------------------------------
function resolveUrl(raw, ctx) {
    const value = String(raw).replace(/^<|>$/g, "");
    try {
        const url = new URL(value, ctx.base ?? undefined);
        return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
    } catch {
        return null;
    }
}

function anchor(href) {
    const a = h("a", { class: "md-link", rel: "noopener noreferrer", target: "_blank" });
    a.setAttribute("href", href);
    return a;
}

const LINK = /\[((?:[^\[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
const IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;
const DEL = /~~(?=\S)([\s\S]*?\S)~~/y;
const WORK_ITEM_KEY = /[A-Z][A-Z0-9_]{1,19}-\d{1,9}(?![\w-])/y;
const MENTION = /@([A-Za-z0-9_][A-Za-z0-9_.-]{0,254})/y;

function sticky(re, text, i) {
    re.lastIndex = i;
    return re.exec(text);
}

function trimUrl(url) {
    let end = url.length;
    while (end > 0) {
        const last = url[end - 1];
        if (/[.,;:!?'"*_~]/.test(last)) end--;
        else if (last === ")" && (url.slice(0, end).match(/\(/g) ?? []).length < (url.slice(0, end).match(/\)/g) ?? []).length) end--;
        else break;
    }
    return url.slice(0, end);
}

function tryRule(char, text, i, prev, ctx, depth, noLinks) {
    if (ctx.onRef && !noLinks && char >= "A" && char <= "Z" && !/[\w-]/.test(prev)) {
        const m = sticky(WORK_ITEM_KEY, text, i);
        if (m && (ctx.isRef?.(m[0]) ?? true)) {
            const key = m[0];
            return { end: i + key.length, node: h("button", { type: "button", class: "md-ref", title: `Open ${key}`, onclick: () => ctx.onRef(key) }, key) };
        }
    }
    switch (char) {
        case "\\": {
            const next = text[i + 1];
            return next && /[\\`*_{}\[\]()#+\-.!~|><@]/.test(next) ? { end: i + 2, node: document.createTextNode(next) } : null;
        }
        case "`": {
            let run = 1;
            while (text[i + run] === "`") run++;
            const fence = "`".repeat(run);
            let close = text.indexOf(fence, i + run);
            while (close !== -1 && (text[close - 1] === "`" || text[close + run] === "`")) close = text.indexOf(fence, close + 1);
            if (close === -1) return null;
            let code = text.slice(i + run, close);
            if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
            return { end: close + run, node: h("code", { class: "md-code" }, code.replace(/\n/g, " ")) };
        }
        case "!": {
            const m = sticky(IMAGE, text, i);
            if (!m) return null;
            const href = resolveUrl(m[2], ctx);
            const label = m[1] || "image";
            if (!href) return { end: i + m[0].length, node: document.createTextNode(label) };
            const a = anchor(href);
            a.classList.add("md-image");
            a.append(`Image: ${label}`);
            return { end: i + m[0].length, node: a };
        }
        case "[": {
            const m = sticky(LINK, text, i);
            if (!m) return null;
            const href = noLinks ? null : resolveUrl(m[2], ctx);
            const holder = href ? anchor(href) : document.createDocumentFragment();
            inline(m[1], holder, ctx, depth + 1, true);
            return { end: i + m[0].length, node: holder };
        }
        case "<": {
            const m = sticky(AUTOLINK, text, i);
            if (!m || noLinks) return null;
            const href = resolveUrl(m[1], ctx);
            if (!href) return null;
            const a = anchor(href);
            a.append(m[1]);
            return { end: i + m[0].length, node: a };
        }
        case "h": {
            if (noLinks || ALNUM.test(prev)) return null;
            const m = sticky(BARE_URL, text, i);
            if (!m) return null;
            const url = trimUrl(m[0]);
            const href = resolveUrl(url, ctx);
            if (!href) return null;
            const a = anchor(href);
            a.append(url);
            return { end: i + url.length, node: a };
        }
        case "~": {
            const m = sticky(DEL, text, i);
            if (!m) return null;
            const node = h("del");
            inline(m[1], node, ctx, depth + 1, noLinks);
            return { end: i + m[0].length, node };
        }
        case "@": {
            if (/[\w@]/.test(prev)) return null;
            const m = sticky(MENTION, text, i);
            if (!m) return null;
            const name = m[1].replace(/[.-]+$/, "");
            return { end: i + 1 + name.length, node: h("span", { class: "md-mention" }, `@${name}`) };
        }
        case "\n":
            return { end: i + 1, node: h("br") };
        default:
            return null;
    }
}

// Emphasis follows the CommonMark delimiter-run algorithm: `*`/`_` runs become text nodes tagged with their flanking
// ability, then a stack pass wraps the nodes between matched pairs. Anything left unmatched stays literal text.
const MAX_DELIMITER_RUNS = 400;
const isSpace = (c) => c === undefined || /\s/.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

function delimiterRun(char, node, before, after) {
    const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
    const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
    const underscore = char === "_";
    return {
        node,
        char,
        size: node.data.length,
        canOpen: underscore ? left && (!right || isPunct(before)) : left,
        canClose: underscore ? right && (!left || isPunct(after)) : right,
    };
}

function resolveEmphasis(runs) {
    if (runs.length < 2 || runs.length > MAX_DELIMITER_RUNS) return;
    for (let c = 1; c < runs.length; c++) {
        const closer = runs[c];
        while (closer.canClose && closer.node.data) {
            let o = c - 1;
            for (; o >= 0; o--) {
                const candidate = runs[o];
                if (candidate.char !== closer.char || !candidate.canOpen || !candidate.node.data) continue;
                const tooAmbiguous = (candidate.canClose || closer.canOpen)
                    && (candidate.size + closer.size) % 3 === 0
                    && !(candidate.size % 3 === 0 && closer.size % 3 === 0);
                if (!tooAmbiguous) break;
            }
            if (o < 0) break;
            const opener = runs[o];
            const use = opener.node.data.length >= 2 && closer.node.data.length >= 2 ? 2 : 1;
            const wrapper = h(use === 2 ? "strong" : "em");
            for (let n = opener.node.nextSibling; n && n !== closer.node; ) {
                const next = n.nextSibling;
                wrapper.append(n);
                n = next;
            }
            opener.node.after(wrapper);
            opener.node.data = opener.node.data.slice(0, -use);
            closer.node.data = closer.node.data.slice(use);
            for (let k = o + 1; k < c; k++) runs[k].canOpen = runs[k].canClose = false;
            if (!opener.node.data) opener.node.remove();
            if (!closer.node.data) closer.node.remove();
        }
    }
}

function inline(text, parent, ctx, depth, noLinks = false) {
    if (depth > MAX_DEPTH || text.length > MAX_INLINE_CHARS) {
        parent.append(document.createTextNode(text));
        return;
    }
    const runs = [];
    let plain = "";
    const flush = () => {
        if (plain) {
            parent.append(document.createTextNode(plain));
            plain = "";
        }
    };
    for (let i = 0; i < text.length; ) {
        const char = text[i];
        if (char === "*" || char === "_") {
            let end = i + 1;
            while (text[end] === char) end++;
            flush();
            const node = document.createTextNode(text.slice(i, end));
            parent.append(node);
            runs.push(delimiterRun(char, node, text[i - 1], text[end]));
            i = end;
            continue;
        }
        const hit = tryRule(char, text, i, i ? text[i - 1] : "", ctx, depth, noLinks);
        if (hit) {
            flush();
            parent.append(hit.node);
            i = hit.end;
        } else {
            plain += text[i++];
        }
    }
    flush();
    resolveEmphasis(runs);
}
