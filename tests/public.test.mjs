// The UI is plain browser modules and one stylesheet with no build step, so a mistyped import, id or variable would only show up
// as a blank or unstyled panel. These checks read the files the way the browser, and the policy of a VS Code webview, would.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../jira-copilot-canvas/public/", import.meta.url));

const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
const css = await readFile(path.join(PUBLIC, "app.css"), "utf8");
const theme = await readFile(fileURLToPath(new URL("../vscode/theme.css", import.meta.url)), "utf8");
const modules = Object.fromEntries(
    await Promise.all(
        (await readdir(path.join(PUBLIC, "js")))
            .filter((name) => name.endsWith(".js"))
            .sort()
            .map(async (name) => [name, await readFile(path.join(PUBLIC, "js", name), "utf8")]),
    ),
);
const names = Object.keys(modules);
const isFile = (file) => stat(file).then((info) => info.isFile(), () => false);

// "a, b as c" -> [{ name: "a", alias: "a" }, { name: "b", alias: "c" }]
const specifiers = (list) =>
    list
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const [name, alias = name] = part.split(/\s+as\s+/);
            return { name, alias };
        });

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+\.js)";$/;
const EXPORT_DECLARATION = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?$/;

// A small linker. It only understands single-line named imports and exports, and anything else is reported rather than
// skipped, so the checks below can never pass because a line was not understood.
function link(name, source) {
    const module = { imports: [], exports: new Set(), unsupported: [] };
    source.split("\n").forEach((line, index) => {
        const where = `${name}:${index + 1}`;
        if (/\bimport\s*\(/.test(line)) module.unsupported.push(`${where} ${line.trim()}`);
        else if (/^import\b/.test(line)) {
            const match = IMPORT.exec(line);
            if (match) for (const { name: imported } of specifiers(match[1])) module.imports.push({ from: match[2], name: imported, where });
            else module.unsupported.push(`${where} ${line.trim()}`);
        } else if (/^export\b/.test(line)) {
            const declaration = EXPORT_DECLARATION.exec(line);
            const list = EXPORT_LIST.exec(line);
            if (declaration) module.exports.add(declaration[1]);
            else if (list) for (const { alias } of specifiers(list[1])) module.exports.add(alias);
            else module.unsupported.push(`${where} ${line.trim()}`);
        }
    });
    return module;
}

const graph = Object.fromEntries(names.map((name) => [name, link(name, modules[name])]));
const allImports = names.flatMap((name) => graph[name].imports);
const hits = (files, pattern) => Object.entries(files).flatMap(([name, source]) => source.split("\n").flatMap((line, index) => (pattern.test(line) ? [`${name}:${index + 1}`] : [])));

function findCycle() {
    const progress = new Map();
    const trail = [];
    const visit = (name) => {
        if (progress.get(name) === "done") return null;
        if (progress.get(name) === "visiting") return [...trail.slice(trail.indexOf(name)), name];
        progress.set(name, "visiting");
        trail.push(name);
        for (const target of new Set(graph[name].imports.map((entry) => entry.from))) {
            const cycle = graph[target] ? visit(target) : null;
            if (cycle) return cycle;
        }
        trail.pop();
        progress.set(name, "done");
        return null;
    };
    for (const name of names) {
        const cycle = visit(name);
        if (cycle) return cycle;
    }
    return null;
}

describe("the browser modules", () => {
    test("are all there", () => {
        assert.ok(names.includes("app.js"), names.join(", "));
        assert.ok(names.length >= 14, names.join(", "));
        assert.ok(allImports.length >= 40, `only ${allImports.length} imports were understood`);
    });

    test("use only the import and export forms that these checks understand", () => {
        assert.deepEqual(names.flatMap((name) => graph[name].unsupported), []);
    });

    test("import only files that sit next to them", () => {
        assert.deepEqual(allImports.filter((entry) => !graph[entry.from]).map((entry) => `${entry.where} imports ${entry.from}`), []);
    });

    test("import only names that the other module exports", () => {
        const missing = allImports.filter((entry) => graph[entry.from] && !graph[entry.from].exports.has(entry.name));
        assert.deepEqual(missing.map((entry) => `${entry.where} imports ${entry.name} from ${entry.from}`), []);
    });

    test("do not import each other in a circle, which would read an export before it exists", () => {
        assert.equal(findCycle(), null);
    });

    test("are all reached from the script that the page loads", () => {
        const entry = /<script\b[^>]*\bsrc="\/js\/([\w-]+\.js)"/.exec(html)?.[1];
        assert.ok(graph[entry], `index.html loads ${entry}`);
        const reached = new Set();
        const queue = [entry];
        while (queue.length) {
            const name = queue.pop();
            if (reached.has(name) || !graph[name]) continue;
            reached.add(name);
            queue.push(...graph[name].imports.map((item) => item.from));
        }
        assert.deepEqual(names.filter((name) => !reached.has(name)), []);
    });
});

describe("what the page may do with Jira content", () => {
    test("never parses it as HTML or runs it as code", () => {
        assert.deepEqual(hits(modules, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b|document\.write|\beval\s*\(|new\s+Function\b|javascript:/), []);
    });

    test("leaves the network to api.js, because a webview may not connect anywhere itself", () => {
        const network = /\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon|importScripts/;
        const { "api.js": api, ...others } = modules;
        assert.match(api, network);
        assert.deepEqual(hits(others, network), []);
    });

    test("opens a link in a new tab only with noopener", () => {
        const opening = hits(modules, /target:\s*"_blank"/);
        assert.ok(opening.length > 0);
        const lines = (location) => modules[location.split(":")[0]].split("\n")[Number(location.split(":")[1]) - 1];
        assert.deepEqual(opening.filter((location) => !/rel:\s*"[^"]*\bnoopener\b/.test(lines(location))), []);
    });
});

describe("index.html", () => {
    test("loads one module script from a file, with no inline script or event handler", () => {
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        assert.equal(scripts.length, 1);
        assert.match(scripts[0][1], /\btype="module"/);
        assert.match(scripts[0][1], /\bsrc="\/js\/app\.js"/);
        assert.equal(scripts[0][2].trim(), "");
        assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
    });

    test("refers only to files that exist", async () => {
        const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]).filter((reference) => !reference.startsWith("data:"));
        assert.ok(references.length >= 2, references.join(", "));
        const missing = [];
        for (const reference of references) {
            const local = reference.startsWith("/") ? path.join(PUBLIC, reference.split(/[?#]/)[0]) : null;
            if (!local || !(await isFile(local))) missing.push(reference);
        }
        assert.deepEqual(missing, []);
    });

    test("has every element that a module looks up by id", () => {
        const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
        const wanted = Object.values(modules).flatMap((source) => [...source.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]));
        assert.ok(wanted.length >= 4, wanted.join(", "));
        assert.deepEqual([...new Set(wanted)].filter((id) => !present.has(id)), []);
    });

    test("declares its language, its viewport and a title", () => {
        assert.match(html, /<html\b[^>]*\blang="[a-z-]+"/i);
        assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*width=device-width/i);
        assert.match(html, /<title>[^<]+<\/title>/i);
    });
});

describe("app.css", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rulesOf = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")), body: match[2] }));
    const declarations = (text) => [...text.matchAll(/(?:^|[\s{;])(--[\w-]+)\s*:/g)].map((match) => match[1]);
    const declared = new Set(declarations(code));
    const fromScript = new Set(Object.values(modules).flatMap((source) => [...source.matchAll(/["'`](--[\w-]+)/g)].map((match) => match[1])));
    const reads = [...code.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)].map((match) => ({ name: match[1], fallback: match[2] === "," }));
    const fromHost = [...new Set(reads.map((read) => read.name).filter((name) => !declared.has(name) && !fromScript.has(name)))].sort();

    test("has balanced braces", () => {
        let depth = 0;
        for (const character of code) {
            if (character === "{") depth += 1;
            else if (character === "}") depth -= 1;
            assert.ok(depth >= 0, "a } closes nothing");
        }
        assert.equal(depth, 0);
    });

    test("never transitions every property", () => {
        assert.doesNotMatch(code, /transition(?:-property)?\s*:[^;{}]*\ball\b/);
    });

    test("stops animating when asked to", () => {
        assert.match(code, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    });

    // An override only wins when it is as specific as the rule it silences, so each animated selector must be repeated verbatim.
    test("silences every animated selector under prefers-reduced-motion", () => {
        const start = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/.exec(bare);
        assert.ok(start, "no prefers-reduced-motion block");
        const inner = start.index + start[0].length;
        let end = inner;
        for (let depth = 1; depth > 0 && end < bare.length; end += 1) depth += bare[end] === "{" ? 1 : bare[end] === "}" ? -1 : 0;
        const silenced = new Set(rulesOf(bare.slice(inner, end)).filter((rule) => /\banimation\s*:\s*none\b/.test(rule.body)).flatMap((rule) => rule.selectors));
        const animated = rulesOf(bare.slice(0, start.index) + bare.slice(end))
            .filter((rule) => /(?:^|[\s;])animation\s*:\s*(?!none\b)/.test(rule.body))
            .flatMap((rule) => rule.selectors);
        assert.ok(animated.length >= 5, `found only: ${animated.join(" | ")}`);
        assert.deepEqual(animated.filter((selector) => !silenced.has(selector)), []);
    });

    test("loads nothing over the network", () => {
        assert.doesNotMatch(code, /@import/);
        const remote = [...code.matchAll(/url\(\s*["']?\s*(https?:|\/\/)/gi)];
        assert.deepEqual(remote.map((match) => match[0]), []);
    });

    test("reads every variable it does not define from the host, and the VS Code theme provides exactly those", () => {
        assert.ok(fromHost.length >= 10, fromHost.join(", "));
        assert.deepEqual([...new Set(declarations(theme))].sort(), fromHost);
    });

    test("falls back to its own value wherever it reads a host variable", () => {
        assert.deepEqual([...new Set(reads.filter((read) => fromHost.includes(read.name) && !read.fallback).map((read) => read.name))], []);
    });

    test("defines no variable that nothing reads", () => {
        const read = new Set(reads.map((entry) => entry.name));
        assert.deepEqual([...declared].filter((name) => !read.has(name)), []);
    });

    // A mistyped class name is not an error anywhere: the element is just left unstyled. These only group or locate elements.
    const HOOKS = new Set(["backlog", "head-slot", "launch-slot"]);

    test("styles every class that a module gives to an element", () => {
        const styled = new Set([...code.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]));
        const used = Object.entries(modules).flatMap(([name, source]) =>
            source
                .split("\n")
                .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
                .flatMap((line) => [...line.matchAll(/\bclass:\s*"([^"]*)"/g)])
                .flatMap((match) => match[1].split(/\s+/).filter(Boolean).map((className) => ({ className, name }))),
        );
        assert.ok(used.length >= 200, `found only ${used.length} classes`);
        assert.ok(used.some(({ className }) => className === "screen-hint"));
        assert.deepEqual(used.filter(({ className }) => !styled.has(className) && !HOOKS.has(className)).map(({ className, name }) => `${name}: ${className}`), []);
    });
});
