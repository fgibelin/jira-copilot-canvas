// The README states facts that live in the code: tool names, section ids, limits, scripts, quoted messages and links. These
// tests read the README and hold each of those claims against its source, so that neither side can change without the other.
import "./harness/register.mjs";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { NOT_CONNECTED } from "../jira-copilot-canvas/atlassian.mjs";
import { INTENTS, NAME_MAX, SESSION_LIMITS, buildIssueSession } from "../jira-copilot-canvas/session-launch.mjs";
import { TABS } from "../jira-copilot-canvas/workbench.mjs";
import { ALLOWED_OPERATIONS, ALLOWED_TOOLS, createMockAtlassian } from "./harness/mock-atlassian.mjs";
import { captured } from "./harness/shim-sdk.mjs";

await import("../jira-copilot-canvas/extension.mjs");
const canvas = captured.config.canvases[0];

const ROOT = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), "utf8");
const readme = read("README.md").replace(/[\u00a0\u202f]/g, " ");
const pkg = JSON.parse(read("package.json"));

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const plain = (text) => text.replace(/[`*]/g, "");
const spaced = (number) => String(number).replace(/\B(?=(\d{3})+$)/g, " ");

const SHIPPED = ["jira-copilot-canvas", "vscode"].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, ROOT), { recursive: true })
        .filter((file) => /\.(?:mjs|cjs|js|html)$/.test(file))
        .map((file) => ({ file: `${dir}/${file}`, text: read(`${dir}/${file}`) })),
);

/** The body of the section with this title, up to the next heading of the same or a higher level. */
function section(title) {
    let level = 0;
    let fenced = false;
    const body = [];
    for (const line of readme.split("\n")) {
        if (line.trimStart().startsWith("```")) fenced = !fenced;
        const depth = fenced ? 0 : (/^(#{1,6}) /.exec(line)?.[1].length ?? 0);
        if (level && depth && depth <= level) break;
        if (level) body.push(line);
        else if (depth && line.slice(depth + 1) === title) level = depth;
    }
    assert.ok(level, `the README has a section titled "${title}"`);
    return body.join("\n");
}

/** The tables of a text, each as its body rows (header and delimiter dropped) of raw cells. */
function tables(text) {
    const found = [];
    let rows = null;
    for (const line of [...text.split("\n"), ""]) {
        const row = line.trim();
        if (row.startsWith("|") && row.endsWith("|")) (rows ??= []).push(row.slice(1, -1).split("|").map((value) => value.trim()));
        else if (rows) {
            found.push(rows.slice(2));
            rows = null;
        }
    }
    return found;
}

function firstTable(title) {
    const [rows] = tables(section(title));
    assert.ok(rows?.length, `the "${title}" section has a table`);
    return rows;
}

/** The second cell of the row whose first cell reads `name`. */
function cell(rows, name) {
    const row = rows.find(([first]) => plain(first) === name);
    assert.ok(row, `a row for "${name}"`);
    return row[1];
}

/** Every match of a global pattern. There must be one, so that a loop over the matches cannot pass by checking nothing. */
function all(text, pattern) {
    const found = [...text.matchAll(pattern)];
    assert.ok(found.length > 0, `${pattern} matches nothing`);
    return found;
}

/** Evaluates `const NAME = <expression>;` from a source file, so that a limit is read from the code and never copied. */
function constant(file, name) {
    const match = new RegExp(`^(?:export )?const ${name} = (.+);$`, "m").exec(read(file));
    assert.ok(match, `${name} is declared in ${file}`);
    return vm.runInNewContext(match[1]);
}

describe("the tools in the README", () => {
    const rows = firstTable("Agent and Copilot Chat tools");

    it("are the canvas actions, in order, and every count of them agrees", () => {
        assert.deepEqual(rows.map(([name]) => plain(name)), canvas.actions.map((action) => action.name));
        for (const [phrase, count] of all(readme, /\b(\d+)(?: read-only)? (?:tools|actions)\b/g)) assert.equal(Number(count), canvas.actions.length, phrase);
    });

    it("carry the names that package.json declares for VS Code", () => {
        const tools = pkg.contributes.languageModelTools;
        assert.deepEqual(tools.map((tool) => tool.name), canvas.actions.map((action) => `jira_canvas_${action.name}`));
        const references = new Set(tools.map((tool) => tool.toolReferenceName));
        for (const [, name] of all(readme, /#(jira_\w+)/g)) assert.ok(references.has(name), `#${name} is not a tool reference`);
    });

    it("describe parameters and result fields that exist", () => {
        const { properties } = canvas.actions.find((action) => action.name === "list_issues").inputSchema;
        const search = cell(rows, "list_issues");
        for (const [, name] of all(search, /`(\w+)`/g)) assert.ok(Object.hasOwn(properties, name), `list_issues takes ${name}`);
        const fallback = /default (\d+)/.exec(properties.limit.description)[1];
        assert.ok(search.includes(`${fallback} by default, ${properties.limit.maximum} at most`));

        const actions = read("jira-copilot-canvas/actions.mjs");
        for (const [, field] of all(cell(rows, "get_issue"), /`(\w+)`/g)) assert.ok(actions.includes(field), `get_issue returns ${field}`);
    });
});

describe("opening the canvas, as the README describes it", () => {
    it("documents every input of the canvas and the sections that `tab` accepts", () => {
        const rows = firstTable("Open the canvas");
        assert.deepEqual(rows.map(([name]) => plain(name)), Object.keys(canvas.inputSchema.properties));
        assert.deepEqual(all(cell(rows, "tab"), /`(\w+)`/g).map((match) => match[1]), [...TABS]);
    });

    it("names the canvas and the VS Code command the way the extension registers them", () => {
        assert.ok(readme.includes(`**${canvas.displayName}**`));
        assert.equal(pkg.contributes.commands.length, 1);
        const [command] = pkg.contributes.commands;
        assert.ok(readme.includes(`**${command.category}: ${command.title}**`));
    });
});

describe("the sections of a space in the README", () => {
    it("are the tabs of the UI and of the canvas, in order", () => {
        const toolbar = read("jira-copilot-canvas/public/js/toolbar.js");
        const entries = all(toolbar.match(/const TABS = \[([\s\S]*?)\n\];/)[1], /id: "(\w+)", label: "([^"]+)"/g);
        const labels = entries.map((entry) => entry[2]);
        assert.deepEqual(entries.map((entry) => entry[1]), [...TABS]);
        assert.deepEqual(firstTable("Jira").map(([label]) => plain(label)), labels);
        assert.ok(section("Jira").includes(`shows ${WORDS[labels.length]} sections`));
        assert.ok(readme.includes(`${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`));
    });
});

describe("the commands and files in the README", () => {
    it("only use npm scripts and project files that exist", () => {
        for (const [, name] of all(readme, /\bnpm run ([\w:-]+)/g)) assert.ok(Object.hasOwn(pkg.scripts, name), `npm run ${name}`);
        assert.ok(Object.hasOwn(pkg.scripts, "test"));
        for (const [file] of all(readme, /\bscripts\/[\w-]+\.mjs\b/g)) assert.ok(existsSync(new URL(file, ROOT)), file);
        assert.ok(read("scripts/test-vscode.mjs").includes("VSCODE_EXECUTABLE_PATH"));
    });

    it("install with the options the installer accepts", () => {
        const installer = read("scripts/install.mjs");
        for (const option of ["--user", "--project"]) {
            assert.ok(installer.includes(`"${option}"`), option);
            assert.ok(readme.includes(`node scripts/install.mjs ${option}`), option);
        }
    });

    it("name the packages that the scripts and the workflow produce", () => {
        assert.ok(pkg.scripts["package:vscode"].includes("--out dist/jira-copilot-canvas.vsix"));
        assert.ok(read("scripts/package-copilot.mjs").includes("dist/jira-copilot-canvas.tar.gz"));
        for (const file of ["dist/jira-copilot-canvas.vsix", "dist/jira-copilot-canvas.tar.gz"]) assert.ok(readme.includes(file), file);
        assert.match(read(".github/workflows/ci.yml"), /name: jira-copilot-canvas\n\s+path: dist\/\*/);
        assert.ok(readme.includes("the `jira-copilot-canvas` artifact"));
    });

    it("point at this repository, at the extension folder and at files that exist", () => {
        const repository = pkg.repository.url.replace(/\.git$/, "");
        assert.ok(readme.includes(`git clone ${pkg.repository.url}`));
        assert.ok(readme.includes(`${repository}/tree/main/jira-copilot-canvas`));
        for (const file of ["extension.mjs", "copilot-extension.json"]) assert.ok(existsSync(new URL(`jira-copilot-canvas/${file}`, ROOT)), file);
        const relative = all(readme, /\]\(([^)#]+)\)/g).map((match) => match[1]).filter((target) => !/^[a-z]+:/i.test(target));
        assert.ok(relative.length > 0);
        for (const target of relative) assert.ok(existsSync(new URL(target, ROOT)), target);
        assert.equal(pkg.license, "MIT");
        assert.match(read("LICENSE"), /^MIT License/);
    });

    it("ask for the Node.js and VS Code versions that package.json requires", () => {
        assert.match(pkg.engines.node, /^>=\d+$/);
        assert.ok(readme.includes(`Node.js ${pkg.engines.node.slice(2)} or later`));
        const vscode = /^\^(\d+\.\d+)\.0$/.exec(pkg.engines.vscode)[1];
        assert.ok(readme.includes(`VS Code ${vscode} or later`));
    });

    it("describe a project layout that lists every top-level directory", () => {
        const layout = /```\n(jira-copilot-canvas\/[\s\S]*?)\n```/.exec(readme)[1];
        const listed = all(layout, /^(\S+)\/\s{2,}/gm).map((match) => match[1]);
        const present = readdirSync(ROOT, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "dist"].includes(entry.name))
            .map((entry) => entry.name);
        assert.deepEqual([...listed].sort(), present.sort());
    });

    it("does not hard-code a number of tests, which would go stale", () => {
        assert.doesNotMatch(readme, /\b\d+ (?:unit |integration )?tests\b/);
    });
});

describe("the Atlassian connection in the README", () => {
    it("uses the address that the canvas tells people to connect, in prose and in the JSON example", () => {
        const url = /remote server (https:\/\/\S+?)\)/.exec(NOT_CONNECTED)[1];
        assert.ok(readme.includes(`\`${url}\``));
        const example = /```json\n\s*([\s\S]*?)\n\s*```/.exec(readme)[1];
        assert.deepEqual(JSON.parse(example), { servers: { atlassian: { type: "http", url } } });
    });

    it("quotes the messages that the canvas shows", () => {
        const quoted = [
            ...firstTable("Troubleshooting").map(([message]) => /\*([^*]+)\*/.exec(message)[1]),
            /the canvas shows \*"([^"]+)"\*/.exec(readme)[1],
            /they answer \*"([^"]+)"\*/.exec(readme)[1],
        ];
        for (const message of quoted.map((value) => value.replace(/\.$/, ""))) {
            assert.ok(SHIPPED.some(({ text }) => text.includes(message)), `"${message}" is shown by no shipped file`);
        }
    });
});

describe("the security claims in the README", () => {
    const security = plain(section("Security"));

    it("count the Atlassian tools the tests allow, and name write tools that the mock server offers and the tests forbid", () => {
        assert.ok(ALLOWED_TOOLS.includes("executeRead"));
        const named = ALLOWED_TOOLS.filter((name) => name !== "executeRead").length;
        assert.ok(security.includes(`${WORDS[named]} named Atlassian MCP tools`));
        assert.ok(security.includes(`executeRead tool for ${WORDS[ALLOWED_OPERATIONS.length]} more operations`));

        const writes = /write tools the server exposes \(([^)]+)\)/.exec(security)[1].split(", ");
        const offered = createMockAtlassian().toolList().map((tool) => tool.name);
        for (const name of writes) {
            assert.ok(offered.includes(name), `the mock server offers ${name}`);
            assert.ok(!ALLOWED_TOOLS.includes(name), `${name} is not allowed`);
        }
    });

    it("hold: nothing is stored, the server is local with capped bodies, and the tests it relies on exist", () => {
        const stores = /\b(?:writeFile(?:Sync)?|appendFile|createWriteStream|mkdir|mkdtemp|copyFile|unlink|rmSync|localStorage|sessionStorage|indexedDB|globalState|workspaceState|document\.cookie)\b|\.secrets\b/;
        assert.deepEqual(SHIPPED.filter(({ text }) => stores.test(text)).map(({ file }) => file), []);
        assert.ok(read("jira-copilot-canvas/server.mjs").includes("127.0.0.1"));
        assert.equal(constant("jira-copilot-canvas/server.mjs", "MAX_BODY_BYTES"), 1024 * 1024);
        assert.ok(security.includes("capped at 1 MiB"));
        assert.match(read("tests/public.test.mjs"), /innerHTML/);
        assert.match(read("tests/dependencies.test.mjs"), /sha512/);
        assert.deepEqual(pkg.dependencies ?? {}, {});
    });
});

describe("the limits in the README", () => {
    const limits = firstTable("Limits");
    const service = "jira-copilot-canvas/atlassian.mjs";
    const seconds = (name) => constant(service, name) / 1000;

    it("are the constants of the Atlassian service", () => {
        assert.equal(plain(cell(limits, "Page size")), `${constant(service, "PAGE_SIZE")} work items, up to ${constant(service, "MAX_PAGE_SIZE")}`);
        assert.equal(plain(cell(limits, "Pages fetched when listing spaces and boards")), `at most ${constant(service, "MAX_PAGES")}`);

        const cache = plain(cell(limits, "Cache"));
        assert.ok(cache.includes(`Jira and Confluence data ${seconds("CACHE_TTL_MS")} s`));
        assert.ok(cache.includes(`the tool list ${seconds("TOOLS_TTL_MS")} s`));
        assert.ok(cache.includes(`the site list ${constant(service, "SITES_TTL_MS") / 60_000} min`));

        const call = plain(cell(limits, "One Atlassian call"));
        assert.ok(call.includes(`${seconds("CALL_TIMEOUT_MS")} s timeout`));
        assert.ok(call.includes(`at most ${constant(service, "MAX_PARALLEL")} in parallel`));
    });

    it("are the limits on the text that goes to the agent", () => {
        const limit = constant("jira-copilot-canvas/actions.mjs", "AGENT_LIMITS");
        const agent = plain(cell(limits, "Text returned to the agent"));
        assert.ok(agent.includes(`description ${spaced(limit.description)} characters`));
        assert.ok(agent.includes(`${limit.comments} comments of ${spaced(limit.commentChars)} characters each`));
        assert.ok(agent.includes(`Confluence page ${spaced(limit.page)} characters`));
    });
});

describe("starting a session, as the README describes it", () => {
    const title = "New Copilot session from a work item";
    const text = plain(section(title));

    it("offers the intents of the launcher, in the modes it uses", () => {
        const rows = firstTable(title);
        assert.deepEqual(rows.map(([intent]) => plain(intent).toLowerCase()), Object.keys(INTENTS));
        assert.deepEqual(rows.map((row) => row[2]), Object.values(INTENTS).map((intent) => intent.mode));
    });

    it("states the limits of the prompt and of the session name", () => {
        assert.ok(text.includes(`up to ${spaced(SESSION_LIMITS.notes)} characters`));
        assert.ok(text.includes(`kept to ${NAME_MAX} characters`));
        assert.ok(text.includes(`description (up to ${spaced(SESSION_LIMITS.description)} characters)`));
        assert.ok(text.includes(`up to ${SESSION_LIMITS.related} sub-tasks and ${SESSION_LIMITS.related} links`));
        assert.ok(text.includes(`newest ${SESSION_LIMITS.comments} comments (each up to ${spaced(SESSION_LIMITS.commentChars)} characters)`));
    });

    it("quotes the warning that the prompt really carries", () => {
        const warning = /declared untrusted \("([^"]+)"\)/.exec(text)[1];
        const { prompt } = buildIssueSession({ key: "KAN-1", summary: "Example" }, { intent: "context" });
        assert.ok(prompt.includes(warning));
    });
});
