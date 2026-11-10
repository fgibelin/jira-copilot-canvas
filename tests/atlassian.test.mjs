import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { AtlassianError, NOT_CONNECTED, READ_TOOLS, adfToMarkdown, bodyText, buildJql, categoryOf, createAtlassian, htmlToText, parseToolResult, patterns, quoteJql, splitOrderBy } from "../jira-copilot-canvas/atlassian.mjs";
import { ALICE, ALLOWED_OPERATIONS, ALLOWED_TOOLS, BOB, CLOUD_ID, SITE_URL, adf, createMockAtlassian, evaluate, okResult, paragraph, text } from "./harness/mock-atlassian.mjs";

const mocks = [];

function setup(options = {}) {
    const { now, hedgeMs, ...mockOptions } = options;
    const mock = createMockAtlassian(mockOptions);
    mocks.push(mock);
    return { mock, atlassian: createAtlassian({ transport: mock.transport, now, hedgeMs }) };
}

const rejectsWith = (promise, code, pattern) =>
    assert.rejects(promise, (error) => {
        assert.ok(error instanceof AtlassianError, `expected an AtlassianError, got ${error?.constructor?.name}: ${error?.message}`);
        assert.equal(error.code, code, error.message);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });

const callsTo = (mock, name) => mock.calls.filter((call) => call.name === name || call.operation === name);
const keys = (items) => items.map((item) => item.key);

describe("patterns", () => {
    it("accepts Jira issue keys and space keys, and nothing else", () => {
        for (const key of ["KAN-1", "kan-12", "A1_B-22", "SAM1-300"]) assert.match(key, patterns.KEY_RE, key);
        for (const key of ["1KAN-1", "KAN-", "KAN-1x", "KAN 1", "-1", "KAN-1\n", "KAN--1", ""]) assert.doesNotMatch(key, patterns.KEY_RE, JSON.stringify(key));
        for (const key of ["KAN", "SAM1", "a_b", "A".repeat(30)]) assert.match(key, patterns.SPACE_RE, key);
        for (const key of ["1KAN", "K-N", "", "A".repeat(31), "KA N", 'K"'] ) assert.doesNotMatch(key, patterns.SPACE_RE, JSON.stringify(key));
    });
});

describe("quoteJql", () => {
    it("escapes quotes and backslashes", () => {
        assert.equal(quoteJql('a"b'), '"a\\"b"');
        assert.equal(quoteJql("a\\b"), '"a\\\\b"');
        assert.equal(quoteJql(undefined), '""');
        assert.equal(quoteJql(12), '"12"');
    });
});

describe("splitOrderBy", () => {
    it("separates the filter from the sort", () => {
        assert.deepEqual(splitOrderBy("status = Done ORDER BY created DESC"), { clause: "status = Done", orderBy: "created DESC" });
        assert.deepEqual(splitOrderBy("a = 1 order   by key"), { clause: "a = 1", orderBy: "key" });
        assert.deepEqual(splitOrderBy("a = 1"), { clause: "a = 1", orderBy: "" });
        assert.deepEqual(splitOrderBy("ORDER BY key ASC"), { clause: "", orderBy: "key ASC" });
    });

    it("only splits on the words, not on look-alikes", () => {
        assert.deepEqual(splitOrderBy("labels = border by"), { clause: "labels = border by", orderBy: "" });
        assert.deepEqual(splitOrderBy("labels = reorder  by"), { clause: "labels = reorder  by", orderBy: "" });
    });
});

describe("categoryOf", () => {
    it("reads Jira's status category keys and ids", () => {
        assert.equal(categoryOf("new"), "todo");
        assert.equal(categoryOf("indeterminate"), "inprogress");
        assert.equal(categoryOf("done"), "done");
        assert.equal(categoryOf("2"), "todo");
        assert.equal(categoryOf(4), "inprogress");
        assert.equal(categoryOf("3"), "done");
    });

    it("recognises common status names in several languages", () => {
        for (const name of ["To Do", "Open", "Backlog", "Selected for Development", "À faire"]) assert.equal(categoryOf(name), "todo", name);
        for (const name of ["In Progress", "In Review", "Testing", "En cours"]) assert.equal(categoryOf(name), "inprogress", name);
        for (const name of ["Done", "Closed", "Resolved", "Terminé"]) assert.equal(categoryOf(name), "done", name);
    });

    it("skips empty candidates, lets the first recognised one win and has sensible fallbacks", () => {
        assert.equal(categoryOf(undefined, "", null, "Done"), "done");
        assert.equal(categoryOf("new", "Done"), "todo");
        assert.equal(categoryOf("Blocked"), "inprogress");
        assert.equal(categoryOf(), "todo");
        assert.equal(categoryOf(null, ""), "todo");
    });
});

describe("buildJql", () => {
    it("is just an ordering without a space", () => {
        assert.equal(buildJql(), "ORDER BY updated DESC");
    });

    it("scopes to the space and orders by the chosen sort", () => {
        assert.equal(buildJql({ space: "KAN" }), 'project = "KAN" ORDER BY updated DESC');
        const orders = { updated: "updated DESC", created: "created DESC", priority: "priority DESC, updated DESC", due: "duedate ASC, updated DESC", key: "key ASC", nonsense: "updated DESC" };
        for (const [sort, order] of Object.entries(orders)) assert.equal(buildJql({ space: "KAN", sort }), `project = "KAN" ORDER BY ${order}`, sort);
    });

    it("filters on status categories, which do not depend on the language of the site", () => {
        const clauses = { todo: "statusCategory = 2", inprogress: "statusCategory = 4", done: "statusCategory = 3", open: "statusCategory != 3" };
        for (const [status, clause] of Object.entries(clauses)) assert.equal(buildJql({ space: "KAN", status }), `project = "KAN" AND ${clause} ORDER BY updated DESC`, status);
        assert.equal(buildJql({ space: "KAN", status: "all" }), 'project = "KAN" ORDER BY updated DESC');
        assert.equal(buildJql({ space: "KAN", status: "whatever" }), 'project = "KAN" ORDER BY updated DESC');
    });

    it("filters on the assignee: me, unassigned, or an account id", () => {
        assert.match(buildJql({ space: "KAN", assignee: "me" }), /AND assignee = currentUser\(\)/);
        assert.match(buildJql({ space: "KAN", assignee: "unassigned" }), /AND assignee is EMPTY/);
        assert.match(buildJql({ space: "KAN", assignee: ALICE.accountId }), new RegExp(`AND assignee = "${ALICE.accountId}"`));
        assert.match(buildJql({ space: "KAN", assignee: "5b10ac8d82e05b22cc7d4ef5" }), /AND assignee = "5b10ac8d82e05b22cc7d4ef5"/);
        assert.doesNotMatch(buildJql({ space: "KAN", assignee: "any" }), /assignee/);
    });

    it("never copies an arbitrary assignee value into the query", () => {
        for (const assignee of ['x" OR project = "SAM1', "someone", "1:2", "ABC", "me OR 1=1"]) assert.doesNotMatch(buildJql({ space: "KAN", assignee }), /assignee|SAM1|1=1/, assignee);
    });

    it("filters on the issue type and quotes it", () => {
        assert.match(buildJql({ space: "KAN", type: "Subtask" }), /AND issuetype = "Subtask"/);
        assert.match(buildJql({ space: "KAN", type: 'Sub "task"' }), /AND issuetype = "Sub \\"task\\""/);
        assert.doesNotMatch(buildJql({ space: "KAN", type: "   " }), /issuetype/);
    });

    it("quotes the space too", () => {
        assert.equal(buildJql({ space: 'K"AN' }), 'project = "K\\"AN" ORDER BY updated DESC');
    });

    it("searches text, issue keys and bare numbers", () => {
        assert.match(buildJql({ space: "KAN", q: "login bug" }), /AND text ~ "login bug" ORDER BY/);
        assert.match(buildJql({ space: "KAN", q: "kan-12" }), /AND \(key = "KAN-12" OR text ~ "kan 12"\) ORDER BY/);
        assert.match(buildJql({ space: "KAN", q: "12" }), /AND \(key = "KAN-12" OR text ~ "12"\) ORDER BY/);
        assert.equal(buildJql({ q: "12" }), 'text ~ "12" ORDER BY updated DESC');
    });

    it("strips the characters Jira's text search treats as operators, and caps the length", () => {
        assert.equal(buildJql({ space: "KAN", q: 'a+b-c*d?e"f' }), 'project = "KAN" AND text ~ "a b c d e f" ORDER BY updated DESC');
        assert.equal(buildJql({ space: "KAN", q: '()*"' }), 'project = "KAN" ORDER BY updated DESC');
        const long = buildJql({ space: "KAN", q: "a".repeat(500) });
        assert.equal(/text ~ "(a+)"/.exec(long)[1].length, 200);
    });

    it("keeps hostile search text inside its quotes", () => {
        const { mock } = setup();
        for (const q of ['x" OR project = "SAM1', 'x\\" OR project = "SAM1', '" ORDER BY created ASC --', "'; DROP TABLE issues; --", "a)(b", "\u0000\u2028\n\r\t x", 'text ~ "y"', "ORDER BY key"]) {
            const jql = buildJql({ space: "KAN", q });
            assert.match(jql, /^project = "KAN"(?: AND text ~ "[^"\\]*")? ORDER BY updated DESC$/, JSON.stringify(q));
            assert.ok(evaluate(jql, mock.data.issues).every((issue) => issue.project === "KAN"), JSON.stringify(q));
        }
    });

    it("wraps a JQL filter in parentheses, so it cannot widen the space, and lets it choose the order", () => {
        assert.equal(buildJql({ space: "KAN", q: 'status = "Done" OR labels = x', qMode: "jql" }), 'project = "KAN" AND (status = "Done" OR labels = x) ORDER BY updated DESC');
        assert.equal(buildJql({ space: "KAN", q: "labels = x ORDER BY created ASC", qMode: "jql" }), 'project = "KAN" AND (labels = x) ORDER BY created ASC');
        assert.equal(buildJql({ space: "KAN", q: "order by key DESC", qMode: "jql" }), 'project = "KAN" ORDER BY key DESC');
    });

    it("rejects a JQL filter whose parentheses or quotes are unbalanced", () => {
        for (const q of ['x) OR (project = "SAM1"', "a = 1)", "(a = 1", ")(", 'a = "unterminated', "a = 'unterminated"]) {
            assert.throws(() => buildJql({ space: "KAN", q, qMode: "jql" }), (error) => error instanceof AtlassianError && error.code === "invalid", q);
        }
    });

    it("is not fooled by parentheses inside quoted strings", () => {
        assert.equal(buildJql({ space: "KAN", q: 'summary ~ "a)" AND summary ~ \'(b\' AND (labels = x)', qMode: "jql" }), `project = "KAN" AND (summary ~ "a)" AND summary ~ '(b' AND (labels = x)) ORDER BY updated DESC`);
        assert.equal(buildJql({ space: "KAN", q: 'summary ~ "a\\"b)"', qMode: "jql" }), 'project = "KAN" AND (summary ~ "a\\"b)") ORDER BY updated DESC');
    });
});

describe("parseToolResult", () => {
    it("unwraps { data } and keeps the structured block", () => {
        const result = parseToolResult({ ok: true, text: JSON.stringify({ data: { a: 1 } }), structured: { issues: { nodes: [] } } });
        assert.deepEqual(result.data, { a: 1 });
        assert.deepEqual(result.rich, { issues: { nodes: [] } });
    });

    it("parses a structured block that arrives as text", () => {
        assert.deepEqual(parseToolResult({ ok: true, text: "{}", structured: '{"x":1}' }).rich, { x: 1 });
        assert.equal(parseToolResult({ ok: true, text: "{}", structured: "not json" }).rich, null);
        assert.equal(parseToolResult({ ok: true, text: "{}" }).rich, null);
    });

    it("falls back to the whole body, or to plain text", () => {
        assert.deepEqual(parseToolResult({ ok: true, text: "[1,2]" }).data, [1, 2]);
        assert.deepEqual(parseToolResult({ ok: true, text: '{"values":[1]}' }).data, { values: [1] });
        assert.equal(parseToolResult({ ok: true, text: "just text" }).data, "just text");
    });

    const classified = [
        [{ statusCode: 401, message: "Unauthorized" }, "auth"],
        [{ statusCode: 403, message: "nope" }, "forbidden"],
        [{ statusCode: 404, message: "gone" }, "not_found"],
        [{ statusCode: 429, message: "slow down" }, "rate_limited"],
        [{ statusCode: 400, message: "The query is malformed" }, "invalid"],
        [{ statusCode: 500, message: "boom" }, "upstream"],
        [{ message: "Issue does not exist or you do not have permission to see it." }, "not_found"],
        [{ statusCode: 404, message: "Issue does not exist or you do not have permission to see it." }, "not_found"],
        [{ statusCode: 404, message: "Authentication details are missing" }, "not_found"],
        [{ statusCode: 403, message: "Issue does not exist" }, "forbidden"],
        [{ statusCode: 400, message: "Error in the JQL Query: The value 'ZZZ' does not exist for the field 'project'." }, "not_found"],
        [{ message: "You do not have permission to create issues" }, "forbidden"],
        [{ message: "Rate limit exceeded" }, "rate_limited"],
    ];
    for (const [inner, code] of classified) {
        it(`classifies ${JSON.stringify(inner)} as ${code}`, () => {
            assert.throws(
                () => parseToolResult({ ok: false, error: `MCP server 'atlassian': ${JSON.stringify(inner)}` }),
                (error) => {
                    assert.ok(error instanceof AtlassianError);
                    assert.equal(error.code, code);
                    assert.equal(error.message, inner.message);
                    return true;
                },
            );
        });
    }

    it("classifies plain-text failures by what they say", () => {
        const code = (error) => {
            try {
                parseToolResult({ ok: false, error });
            } catch (thrown) {
                return thrown.code;
            }
            return null;
        };
        assert.equal(code("MCP server 'a': Authentication required, sign in again"), "auth");
        assert.equal(code("The token has expired"), "auth");
        assert.equal(code("token expired"), "auth");
        assert.equal(code("The access token is invalid"), "auth");
        assert.equal(code("Failed to connect to the server"), "not_connected");
        assert.equal(code("This operation is not supported"), "unsupported");
        assert.equal(code("something odd"), "upstream");
        assert.equal(code(""), "upstream");
    });

    it("strips the MCP server prefix from messages and has a message even when there is none", () => {
        assert.throws(() => parseToolResult({ ok: false, error: "MCP server 'atlassian': Something odd" }), { message: "Something odd" });
        assert.throws(() => parseToolResult({ ok: false }), { message: "The Atlassian request failed." });
        assert.throws(() => parseToolResult(undefined), { message: "The Atlassian request failed." });
    });

    it("treats an { error: true } body as a failure even when the call itself succeeded", () => {
        assert.throws(
            () => parseToolResult({ ok: true, text: JSON.stringify({ error: true, message: "Not found", statusCode: 404 }) }),
            (error) => error.code === "not_found" && error.message === "Not found",
        );
    });
});

describe("adfToMarkdown", () => {
    it("converts headings, paragraphs and lists", () => {
        const doc = adf({ type: "heading", attrs: { level: 2 }, content: [text("Goal")] }, paragraph(text("Ship the "), text("canvas", [{ type: "strong" }]), text(".")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("first"))] }, { type: "listItem", content: [paragraph(text("second"))] }] });
        assert.equal(adfToMarkdown(doc), "## Goal\n\nShip the **canvas**.\n\n- first\n- second");
    });

    it("nests lists and numbers ordered ones from their start", () => {
        const nested = { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("a")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("b"))] }] }] }] };
        assert.equal(adfToMarkdown(adf(nested)), "- a\n  - b");
        const ordered = { type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [paragraph(text("x"))] }, { type: "listItem", content: [paragraph(text("y"))] }] };
        assert.equal(adfToMarkdown(adf(ordered)), "3. x\n4. y");
    });

    it("converts marks, and only links to https", () => {
        const marks = (type, attrs) => paragraph(text("t", [{ type, ...(attrs && { attrs }) }]));
        assert.equal(adfToMarkdown(adf(marks("strong"))), "**t**");
        assert.equal(adfToMarkdown(adf(marks("em"))), "*t*");
        assert.equal(adfToMarkdown(adf(marks("strike"))), "~~t~~");
        assert.equal(adfToMarkdown(adf(marks("code"))), "`t`");
        assert.equal(adfToMarkdown(adf(marks("link", { href: "https://example.com/x" }))), "[t](https://example.com/x)");
        assert.equal(adfToMarkdown(adf(marks("link", { href: "javascript:alert(1)" }))), "t");
        assert.equal(adfToMarkdown(adf(marks("link", { href: "http://example.com" }))), "t");
        assert.equal(adfToMarkdown(adf(paragraph(text("t", [{ type: "strong" }, { type: "em" }])))), "***t***");
    });

    it("converts code blocks, quotes, rules, tables and attachments", () => {
        assert.equal(adfToMarkdown(adf({ type: "codeBlock", attrs: { language: "js" }, content: [text("a()")] })), "```js\na()\n```");
        assert.equal(adfToMarkdown(adf({ type: "blockquote", content: [paragraph(text("one")), paragraph(text("two"))] })), "> one\n> \n> two");
        assert.equal(adfToMarkdown(adf({ type: "rule" })), "---");
        assert.equal(adfToMarkdown(adf({ type: "mediaSingle", content: [{ type: "media" }] })), "[attachment]");
        const cell = (type, value) => ({ type, content: [paragraph(text(value))] });
        const table = { type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] }, { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2 | x")] }] };
        assert.equal(adfToMarkdown(adf(table)), "| A | B |\n| --- | --- |\n| 1 | 2 \\| x |");
    });

    it("escapes backslashes before pipes in table cells", () => {
        const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("a\\|b | c"))] }] }] };
        assert.equal(adfToMarkdown(adf(table)), "| a\\\\\\|b \\| c |\n| --- |");
    });

    it("converts inline nodes", () => {
        const timestamp = Date.UTC(2026, 10, 9);
        const doc = adf(paragraph({ type: "mention", attrs: { text: "@Alice" } }, text(" "), { type: "status", attrs: { text: "DONE" } }, text(" "), { type: "date", attrs: { timestamp: String(timestamp) } }, { type: "hardBreak" }, { type: "inlineCard", attrs: { url: "https://example.com/c" } }, { type: "emoji", attrs: { text: ":)" } }));
        assert.equal(adfToMarkdown(doc), "@Alice [DONE] 2026-11-09\nhttps://example.com/c:)");
    });

    it("tolerates unknown nodes, single nodes and nothing at all", () => {
        assert.equal(adfToMarkdown(adf({ type: "somethingNew", content: [paragraph(text("kept"))] })), "kept");
        assert.equal(adfToMarkdown(paragraph(text("alone"))), "alone");
        assert.equal(adfToMarkdown(null), "");
        assert.equal(adfToMarkdown(adf()), "");
    });
});

describe("htmlToText and bodyText", () => {
    it("removes tags, scripts and styles and decodes the common entities", () => {
        assert.equal(htmlToText("<style>p{}</style><script>alert(1)</script><p>a &amp; b</p><p>&lt;b&gt; &quot;q&quot; &#39;s&#39;</p>"), `a & b\n\n<b> "q" 's'`);
        assert.equal(htmlToText("one<br>two<br/>three"), "one\ntwo\nthree");
        assert.equal(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n\n- b");
    });

    it("reads a description whatever its form", () => {
        assert.equal(bodyText("plain *text*"), "plain *text*");
        assert.equal(bodyText(JSON.stringify(adf(paragraph(text("from adf"))))), "from adf");
        assert.equal(bodyText(adf(paragraph(text("object adf")))), "object adf");
        assert.equal(bodyText("<p>Hello <b>world</b></p>"), "Hello world");
        assert.equal(bodyText({ markdown: "# m" }), "# m");
        assert.equal(bodyText({ value: "<p>v</p>" }), "v");
        assert.equal(bodyText(null), "");
        assert.equal(bodyText(42), "");
        assert.equal(bodyText({}), "");
    });
});

describe("tool discovery", () => {
    it("finds the layered Atlassian toolset", async () => {
        const { atlassian } = setup();
        const box = await atlassian.tools();
        assert.equal(box.server, "atlassian");
        assert.equal(box.layered, true);
        assert.equal(box.byName.get("searchJiraIssuesUsingJql"), "mock-searchJiraIssuesUsingJql");
    });

    it("recognises the older flat toolset", async () => {
        const { atlassian } = setup({ layered: false });
        assert.equal((await atlassian.tools()).layered, false);
    });

    it("prefers the richest server and ignores servers without the required tools", async () => {
        const extraTools = [
            { id: "other-searchJiraIssuesUsingJql", server: "other", name: "searchJiraIssuesUsingJql" },
            { id: "other-getJiraIssue", server: "other", name: "getJiraIssue" },
            { id: "partial-getJiraIssue", server: "partial", name: "getJiraIssue" },
            { id: "orphan", server: "", name: "searchJiraIssuesUsingJql" },
        ];
        const { atlassian } = setup({ extraTools });
        assert.equal((await atlassian.tools()).server, "atlassian");
    });

    it("explains how to connect when there is no Atlassian server", async () => {
        const transport = { tools: async () => [{ id: "x", server: "other", name: "getJiraIssue" }], invoke: async () => ({ ok: true, text: "{}" }) };
        await rejectsWith(createAtlassian({ transport }).tools(), "not_connected", /Atlassian MCP server is not available/);
        await rejectsWith(createAtlassian({ transport: { ...transport, tools: async () => [] } }).listSpaces(), "not_connected", /mcp\.atlassian\.com\/v1\/mcp/);
    });

    it("reports a host that cannot list tools as not connected, with the reason", async () => {
        const transport = { tools: async () => { throw new Error("boom"); }, invoke: async () => ({ ok: true, text: "{}" }) };
        await assert.rejects(createAtlassian({ transport }).tools(), (error) => error.code === "not_connected" && error.message.startsWith(NOT_CONNECTED) && error.message.includes("(boom)"));
    });

    it("does not remember a failure, so connecting later works without a restart", async () => {
        const mock = createMockAtlassian();
        let connected = false;
        const transport = { tools: async () => (connected ? mock.transport.tools() : []), invoke: mock.transport.invoke };
        const atlassian = createAtlassian({ transport });
        await rejectsWith(atlassian.listSpaces(), "not_connected");
        connected = true;
        assert.deepEqual(keys((await atlassian.listSpaces()).spaces), ["KAN", "SAM1"]);
    });

    it("refreshes the tool list every 20 seconds", async () => {
        const mock = createMockAtlassian();
        let clock = 0;
        let listed = 0;
        const transport = { tools: async () => (listed++, mock.transport.tools()), invoke: mock.transport.invoke };
        const atlassian = createAtlassian({ transport, now: () => clock });
        await atlassian.tools();
        await atlassian.tools();
        assert.equal(listed, 1);
        clock += 21_000;
        await atlassian.tools();
        assert.equal(listed, 2);
        await atlassian.tools({ force: true });
        assert.equal(listed, 3);
    });

    it("reports a missing tool as unsupported", async () => {
        const mock = createMockAtlassian();
        mocks.push(mock);
        const transport = { tools: async () => (await mock.transport.tools()).filter((tool) => tool.name !== "listJiraIssueComments"), invoke: mock.transport.invoke };
        await rejectsWith(createAtlassian({ transport }).listComments({ key: "KAN-1" }), "unsupported", /does not provide listJiraIssueComments/);
    });
});

describe("sites", () => {
    it("lists the accessible sites, accepting `id` or `cloudId`", async () => {
        const { atlassian } = setup({ sites: [{ id: "a", url: "https://one.atlassian.net/", name: "one" }, { cloudId: "b", url: "https://two.atlassian.net" }, { id: "c" }, { url: "https://nocloud.atlassian.net" }] });
        assert.deepEqual(await atlassian.sites(), [
            { cloudId: "a", url: "https://one.atlassian.net", name: "one", jira: true, confluence: true },
            { cloudId: "b", url: "https://two.atlassian.net", name: "two", jira: true, confluence: true },
        ]);
    });

    it("picks a site by cloud id, url or name, and by product by default", async () => {
        const sites = [
            { id: "c-conf", url: "https://wiki.atlassian.net", products: [{ name: "confluence" }] },
            { id: "c-jira", url: "https://work.atlassian.net/", name: "work", products: ["jira-software"] },
        ];
        const { atlassian } = setup({ sites });
        assert.equal((await atlassian.siteFor("", "jira")).cloudId, "c-jira");
        assert.equal((await atlassian.siteFor("", "confluence")).cloudId, "c-conf");
        assert.equal((await atlassian.siteFor("")).cloudId, "c-jira");
        for (const wanted of ["work", "https://work.atlassian.net", "c-jira", "  work "]) assert.equal((await atlassian.siteFor(wanted)).cloudId, "c-jira", wanted);
        assert.equal((await atlassian.siteFor("wiki")).cloudId, "c-conf");
    });

    it("rejects an unknown site and an account without any", async () => {
        await rejectsWith(setup().atlassian.siteFor("nope"), "not_found", /Unknown Atlassian site "nope"/);
        await rejectsWith(setup({ sites: [] }).atlassian.siteFor(""), "not_connected", /No Atlassian site is accessible/);
    });

    it("looks sites up once when many requests arrive together, and again after five minutes", async () => {
        let clock = 0;
        const { mock, atlassian } = setup({ now: () => clock });
        await Promise.all([atlassian.listSpaces(), atlassian.listBoards(), atlassian.getIssue({ key: "KAN-1" }), atlassian.listConfluenceSpaces(), atlassian.siteFor("")]);
        assert.equal(callsTo(mock, "getAccessibleAtlassianResources").length, 1);
        clock += 4 * 60_000;
        await atlassian.listSpaces();
        assert.equal(callsTo(mock, "getAccessibleAtlassianResources").length, 1);
        clock += 2 * 60_000;
        await atlassian.getIssue({ key: "KAN-1" });
        assert.equal(callsTo(mock, "getAccessibleAtlassianResources").length, 2);
    });

    it("does not let a refresh that happened meanwhile be overwritten by an older lookup", async () => {
        const { mock, atlassian } = setup();
        mock.stats.latency = 15;
        const first = atlassian.sites();
        atlassian.clearCache();
        mock.stats.latency = 0;
        mock.data.resources = undefined;
        await first;
        await atlassian.sites();
        assert.equal(callsTo(mock, "getAccessibleAtlassianResources").length, 2);
    });
});

describe("spaces and boards", () => {
    it("lists the Jira spaces", async () => {
        const { atlassian } = setup();
        const { site, spaces } = await atlassian.listSpaces();
        assert.equal(site.cloudId, CLOUD_ID);
        assert.deepEqual(spaces[0], { key: "KAN", id: "10000", name: "Product Roadmap", type: "software", style: "next-gen", lead: { id: ALICE.accountId, name: "Alice Martin", avatar: "https://avatar.example/alice/48" }, url: `${SITE_URL}/browse/KAN` });
        assert.deepEqual(keys(spaces), ["KAN", "SAM1"]);
    });

    it("follows the pages of the project list", async () => {
        const { mock, atlassian } = setup({ pageCap: 1 });
        assert.deepEqual(keys((await atlassian.listSpaces()).spaces), ["KAN", "SAM1"]);
        assert.equal(callsTo(mock, "listJiraProjects").length, 2);
    });

    it("lists spaces through the flat toolset too", async () => {
        const { mock, atlassian } = setup({ layered: false });
        assert.deepEqual(keys((await atlassian.listSpaces()).spaces), ["KAN", "SAM1"]);
        assert.deepEqual(mock.calledTools().filter((name) => name !== "getAccessibleAtlassianResources"), ["getVisibleJiraProjects"]);
    });

    it("lists the boards, those of the space first", async () => {
        const { atlassian } = setup();
        const { boards } = await atlassian.listBoards({ space: "KAN" });
        assert.deepEqual(boards.map((board) => board.name), ["KAN board", "SAM1 board"]);
        assert.deepEqual(boards[0], { id: 1, name: "KAN board", type: "simple", isPrivate: false, space: { key: "KAN", name: "Product Roadmap" }, url: `${SITE_URL}/jira/software/projects/KAN/boards/1` });
        assert.deepEqual((await atlassian.listBoards({})).boards.map((board) => board.id), [1, 2]);
    });

    it("has no boards on the flat toolset", async () => {
        const { atlassian } = setup({ layered: false });
        assert.deepEqual((await atlassian.listBoards({ space: "KAN" })).boards, []);
        await rejectsWith(atlassian.getBoard({ id: 1 }), "unsupported", /layered/);
    });

    it("reads the columns of a board and puts the issues in them", async () => {
        const { atlassian } = setup();
        const board = await atlassian.getBoard({ id: 1 });
        assert.equal(board.board.name, "KAN board");
        assert.equal(board.board.space.key, "KAN");
        assert.equal(board.backlog, false);
        assert.deepEqual(board.columns.map((column) => [column.name, column.statuses.map((status) => `${status.id}:${status.category}`)]), [["To Do", ["10000:todo"]], ["In Progress", ["10001:inprogress"]], ["Done", ["10002:done"]]]);
        assert.equal(board.issues.length, 13);
        const column = Object.fromEntries(board.issues.map((issue) => [issue.key, issue.column]));
        assert.deepEqual([column["KAN-1"], column["KAN-2"], column["KAN-3"], column["KAN-4"]], [0, 1, 2, 0]);
        assert.equal(board.nextCursor, null);
        assert.equal(board.hint, null);
    });

    it("builds the columns from the statuses when the board has none configured", async () => {
        const { atlassian } = setup();
        const board = await atlassian.getBoard({ id: 2 });
        assert.deepEqual(board.columns.map((column) => column.name), ["To Do", "In Progress"]);
        assert.deepEqual(board.issues.map((issue) => [issue.key, issue.column]), [["SAM1-1", 0], ["SAM1-2", 1]]);
    });

    it("marks issues whose status is on no column", async () => {
        const { mock, atlassian } = setup();
        mock.data.boardConfigs[1].columnConfig.columns.pop();
        const board = await atlassian.getBoard({ id: 1 });
        assert.equal(board.issues.find((issue) => issue.key === "KAN-3").column, -1);
    });

    it("matches a status by name when its id is not on the board", async () => {
        const { mock, atlassian } = setup();
        mock.data.boardConfigs[1].columnConfig.columns[2].statuses = [{ id: "99", name: "done" }];
        const board = await atlassian.getBoard({ id: 1 });
        assert.equal(board.issues.find((issue) => issue.key === "KAN-3").column, 2);
    });

    it("explains that a kanban board has no backlog", async () => {
        const { atlassian } = setup();
        const backlog = await atlassian.getBoard({ id: 1, backlog: true });
        assert.equal(backlog.backlog, true);
        assert.deepEqual(backlog.issues, []);
        assert.equal(backlog.hint, "Board type is TMP kanban; no backlog exists.");
    });

    it("pages through a long board with a cursor", async () => {
        const { atlassian } = setup({ pageCap: 5 });
        const seen = [];
        let cursor;
        let pages = 0;
        do {
            const page = await atlassian.getBoard({ id: 1, cursor });
            seen.push(...keys(page.issues));
            cursor = page.nextCursor ?? undefined;
            pages++;
        } while (cursor && pages < 10);
        assert.equal(pages, 3);
        assert.equal(new Set(seen).size, 13);
    });

    it("validates the board id and reports a missing board", async () => {
        const { atlassian } = setup();
        for (const id of [undefined, 0, -1, 1.5, "abc", null, "1; DROP"]) await rejectsWith(atlassian.getBoard({ id }), "invalid", /board id/);
        await rejectsWith(atlassian.getBoard({ id: 99 }), "not_found", /Board 99/);
    });
});

describe("issues", () => {
    it("searches a space", async () => {
        const { mock, atlassian } = setup();
        const result = await atlassian.searchIssues({ space: "kan" });
        assert.equal(result.jql, 'project = "KAN" ORDER BY updated DESC');
        assert.equal(result.items.length, 13);
        assert.equal(result.isLast, true);
        assert.equal(result.nextCursor, null);
        const call = mock.calls.find((entry) => entry.name === "searchJiraIssuesUsingJql");
        assert.equal(call.args.cloudId, CLOUD_ID);
        assert.deepEqual(call.args.fields, ["summary", "status", "assignee", "priority", "issuetype", "labels", "duedate", "created", "updated", "parent"]);
        assert.equal(call.args.maxResults, 50);
    });

    it("normalizes an issue", async () => {
        const { atlassian } = setup();
        const { items } = await atlassian.searchIssues({ space: "KAN", q: "Subtask 2.1" });
        // The dot is a search operator character for nothing in Jira, so it survives; the key and parent are what matter here.
        const subtask = (await atlassian.searchIssues({ space: "KAN", type: "Subtask" })).items[0];
        assert.ok(items.length <= 1);
        assert.equal(subtask.key, "KAN-3");
        assert.equal(subtask.url, `${SITE_URL}/browse/KAN-3`);
        assert.deepEqual(subtask.type, { name: "Subtask", subtask: true, level: -1 });
        assert.deepEqual(subtask.status, { name: "Done", id: "10002", category: "done" });
        assert.deepEqual(subtask.parent, { key: "KAN-2", summary: "Task 2", status: { name: "In Progress", id: "10001", category: "inprogress" }, type: "Task" });
        assert.equal(subtask.assignee, null);
        const task = (await atlassian.searchIssues({ space: "KAN", assignee: "me" })).items[0];
        assert.equal(task.key, "KAN-2");
        assert.deepEqual(task.assignee, { id: ALICE.accountId, name: "Alice Martin", avatar: "https://avatar.example/alice/48" });
        assert.deepEqual(task.priority, { name: "High" });
        assert.equal(task.parent, null);
    });

    it("applies every filter", async () => {
        const { atlassian } = setup();
        const find = async (filter) => keys((await atlassian.searchIssues({ space: "KAN", ...filter })).items);
        assert.equal((await find({ status: "todo" })).length, 11);
        assert.deepEqual(await find({ status: "inprogress" }), ["KAN-2"]);
        assert.deepEqual(await find({ status: "done" }), ["KAN-3"]);
        assert.equal((await find({ status: "open" })).length, 12);
        assert.deepEqual(await find({ assignee: "me" }), ["KAN-2"]);
        assert.deepEqual(await find({ assignee: ALICE.accountId }), ["KAN-2"]);
        assert.equal((await find({ assignee: "unassigned" })).length, 12);
        assert.deepEqual(await find({ type: "Subtask" }), ["KAN-3"]);
        assert.deepEqual(await find({ q: "Dummy issue 3" }), ["KAN-6"]);
        assert.deepEqual(await find({ q: "kan-2" }), ["KAN-2"]);
        assert.deepEqual(await find({ q: "3" }), ["KAN-3", "KAN-6"]);
        assert.deepEqual(await find({ q: "assignee = currentUser() ORDER BY created ASC", qMode: "jql" }), ["KAN-2"]);
        assert.equal((await find({ q: "labels = dummy", qMode: "jql" })).length, 10);
    });

    it("sorts", async () => {
        const { atlassian } = setup();
        const order = async (sort) => keys((await atlassian.searchIssues({ space: "KAN", sort })).items).slice(0, 3);
        assert.deepEqual(await order("updated"), ["KAN-1", "KAN-2", "KAN-3"]);
        assert.deepEqual(await order("created"), ["KAN-13", "KAN-12", "KAN-11"]);
        assert.deepEqual(await order("key"), ["KAN-1", "KAN-2", "KAN-3"]);
        assert.deepEqual(await order("due"), ["KAN-1", "KAN-4", "KAN-2"]);
        assert.equal((await order("priority"))[0], "KAN-2");
    });

    it("pages with a cursor and clamps the page size", async () => {
        const { mock, atlassian } = setup();
        const first = await atlassian.searchIssues({ space: "KAN", limit: 5 });
        assert.equal(first.items.length, 5);
        assert.equal(first.isLast, false);
        assert.equal(first.nextCursor, "5");
        const second = await atlassian.searchIssues({ space: "KAN", limit: 5, cursor: first.nextCursor });
        assert.deepEqual(keys(second.items), ["KAN-6", "KAN-7", "KAN-8", "KAN-9", "KAN-10"]);
        const last = await atlassian.searchIssues({ space: "KAN", limit: 5, cursor: "10" });
        assert.equal(last.isLast, true);
        assert.equal(last.nextCursor, null);
        const sizes = [];
        for (const limit of [500, 0, -5, "x", 7]) {
            await atlassian.searchIssues({ space: "KAN", limit });
            sizes.push(mock.calls.at(-1).args.maxResults);
        }
        assert.deepEqual(sizes, [100, 50, 1, 50, 7]);
    });

    it("rejects a bad space, a malformed filter and an unknown space", async () => {
        const { atlassian } = setup();
        for (const space of [undefined, "", "1KAN", "K-N", "A".repeat(31), 'K"AN', "KAN OR x"]) await rejectsWith(atlassian.searchIssues({ space }), "invalid", /space key/);
        await rejectsWith(atlassian.searchIssues({ space: "KAN", q: 'x) OR (project = "SAM1"', qMode: "jql" }), "invalid", /unbalanced/);
        await rejectsWith(atlassian.searchIssues({ space: "ZZZ" }), "not_found", /does not exist/);
    });

    it("blames a mistyped JQL filter on the query, not on a missing space", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("searchJiraIssuesUsingJql", { statusCode: 400, message: "JQL validation failed: Field 'statuss' does not exist or you do not have permission to view it." });
        await rejectsWith(atlassian.searchIssues({ space: "KAN", q: "statuss = Done", qMode: "jql" }), "invalid", /Field 'statuss' does not exist/);
        await rejectsWith(atlassian.searchIssues({ space: "KAN", q: "statuss = Done", qMode: "text" }), "not_found", /does not exist/);
        await rejectsWith(atlassian.searchIssues({ space: "KAN", q: "   ", qMode: "jql" }), "not_found", /does not exist/);
        mock.failWith("searchJiraIssuesUsingJql", { statusCode: 429, message: "slow down" });
        await rejectsWith(atlassian.searchIssues({ space: "KAN", q: "status = Done", qMode: "jql" }), "rate_limited", /slow down/);
    });

    it("keeps a search inside its space", async () => {
        const { atlassian } = setup();
        const { items } = await atlassian.searchIssues({ space: "KAN", q: 'x" OR project = "SAM1' });
        assert.deepEqual(items, []);
    });
});

describe("space summary", () => {
    it("counts a small space exactly", async () => {
        const { mock, atlassian } = setup();
        const summary = await atlassian.spaceSummary({ space: "kan" });
        assert.deepEqual(summary.counts, { total: 13, todo: 11, inprogress: 1, done: 1, overdue: 1, unassigned: 11 });
        assert.equal(summary.exact, true);
        assert.equal(summary.sampled, 13);
        assert.equal(summary.space.name, "Product Roadmap");
        assert.deepEqual(summary.byType, [{ name: "Task", count: 12 }, { name: "Subtask", count: 1 }]);
        assert.deepEqual(summary.byPriority, [{ name: "Medium", count: 12 }, { name: "High", count: 1 }]);
        assert.deepEqual(summary.byAssignee, [{ name: "Unassigned", count: 12 }, { name: "Alice Martin", count: 1 }]);
        assert.deepEqual(keys(summary.recent), ["KAN-1", "KAN-2", "KAN-3", "KAN-4", "KAN-5", "KAN-6", "KAN-7", "KAN-8"]);
        assert.equal(mock.calls.filter((call) => call.args?.searchResultMode === "count").length, 0);
    });

    it("asks Jira for exact totals when the space is larger than one page", async () => {
        const { mock, atlassian } = setup();
        mock.addIssues("KAN", 120);
        const summary = await atlassian.spaceSummary({ space: "KAN" });
        assert.deepEqual(summary.counts, { total: 133, todo: 131, inprogress: 1, done: 1, overdue: 1, unassigned: 131 });
        assert.equal(summary.exact, true);
        assert.equal(summary.sampled, 100);
        const counts = mock.calls.filter((call) => call.args?.searchResultMode === "count").map((call) => call.args.jql).sort();
        assert.deepEqual(counts, [
            'project = "KAN"',
            'project = "KAN" AND assignee is EMPTY AND statusCategory != 3',
            'project = "KAN" AND duedate < startOfDay() AND statusCategory != 3',
            'project = "KAN" AND statusCategory = 2',
            'project = "KAN" AND statusCategory = 3',
            'project = "KAN" AND statusCategory = 4',
        ]);
    });

    it("falls back to the sample, and says so, when a count fails", async () => {
        const { mock, atlassian } = setup();
        mock.addIssues("KAN", 120);
        mock.failWith("searchJiraIssuesUsingJql", (args) => (args.searchResultMode === "count" && /duedate/.test(args.jql) ? mock.failure(500, "count failed") : undefined));
        const summary = await atlassian.spaceSummary({ space: "KAN" });
        assert.equal(summary.exact, false);
        assert.equal(summary.counts.total, 100);
        assert.equal(summary.sampled, 100);
    });

    it("still describes a space that is not in the project list", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("listJiraProjects", { statusCode: 500, message: "projects are down" });
        const summary = await atlassian.spaceSummary({ space: "KAN" });
        assert.deepEqual(summary.space, { key: "KAN", id: "", name: "KAN", type: "", style: "", lead: null, url: `${SITE_URL}/browse/KAN` });
        assert.equal(summary.counts.total, 13);
    });

    it("validates the space", async () => {
        await rejectsWith(setup().atlassian.spaceSummary({ space: "no way" }), "invalid");
        await rejectsWith(setup().atlassian.spaceSummary({ space: "ZZZ" }), "not_found", /does not exist/);
    });
});

describe("one issue", () => {
    it("reads the details, links, sub-tasks and comments", async () => {
        const { mock, atlassian } = setup();
        const issue = await atlassian.getIssue({ key: "kan-2" });
        assert.equal(issue.key, "KAN-2");
        assert.equal(issue.url, `${SITE_URL}/browse/KAN-2`);
        assert.equal(issue.description, "## Goal\n\nShip the **canvas**.\n\n- first\n- second");
        assert.deepEqual(issue.components, ["Backend"]);
        assert.deepEqual(issue.fixVersions, ["1.0"]);
        assert.deepEqual(issue.subtasks.map((subtask) => [subtask.key, subtask.status.category, subtask.type]), [["KAN-3", "done", "Subtask"]]);
        assert.deepEqual(issue.links.map((link) => [link.type, link.label, link.issue.key]), [["Blocks", "blocks", "KAN-1"]]);
        assert.equal(issue.reporter.name, "Alice Martin");
        assert.equal(issue.comments.total, 3);
        assert.deepEqual(issue.comments.items.map((comment) => [comment.author.name, comment.body]), [["Alice Martin", "a"], ["Bob Chen", "b"], ["Alice Martin", "c"]]);
        assert.equal(issue.comments.error, null);
        assert.equal(callsTo(mock, "getJiraIssue")[0].args.view, "evidence");
    });

    it("does not ask for the evidence view on the flat toolset", async () => {
        const { mock, atlassian } = setup({ layered: false });
        await atlassian.getIssue({ key: "KAN-1" });
        assert.equal("view" in callsTo(mock, "getJiraIssue")[0].args, false);
    });

    it("reports a missing issue and a malformed key", async () => {
        const { atlassian } = setup();
        await rejectsWith(atlassian.getIssue({ key: "KAN-999" }), "not_found");
        for (const key of [undefined, "", "KAN", "KAN-", "12", "KAN-1 OR x", "../KAN-1"]) await rejectsWith(atlassian.getIssue({ key }), "invalid", /issue key/);
    });

    it("still shows the issue when its comments cannot be read", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("listJiraIssueComments", { statusCode: 500, message: "comments are down" });
        const issue = await atlassian.getIssue({ key: "KAN-2" });
        assert.deepEqual(issue.comments, { items: [], total: 0, nextStart: null, error: "comments are down" });
        assert.equal(issue.summary, "Task 2");
    });

    it("falls back to the comments embedded in the issue", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("listJiraIssueComments", { statusCode: 500, message: "comments are down" });
        mock.failWith("getJiraIssue", () => mock.ok({ key: "KAN-2", fields: { summary: "x", comment: { total: 1, comments: [{ id: "9", author: BOB, body: "embedded", created: "2026-11-01T00:00:00.000+0000" }] } } }));
        const issue = await atlassian.getIssue({ key: "KAN-2" });
        assert.deepEqual(issue.comments.items.map((comment) => comment.body), ["embedded"]);
        assert.equal(issue.comments.error, null);
        assert.equal(issue.comments.total, 1);
    });

    it("pages through comments", async () => {
        const { mock, atlassian } = setup();
        const first = await atlassian.listComments({ key: "KAN-2", limit: 1 });
        assert.deepEqual([first.items.map((comment) => comment.body), first.total, first.nextStart], [["a"], 3, 1]);
        const second = await atlassian.listComments({ key: "KAN-2", start: 1, limit: 1 });
        assert.deepEqual([second.items.map((comment) => comment.body), second.nextStart], [["b"], 2]);
        const last = await atlassian.listComments({ key: "KAN-2", start: 2, limit: 5 });
        assert.deepEqual([last.items.map((comment) => comment.body), last.nextStart], [["c"], null]);
        await atlassian.listComments({ key: "KAN-2", newestFirst: true });
        assert.equal(mock.calls.at(-1).args.orderBy, "-created");
        assert.equal(mock.calls.at(-1).args.responseContentFormat, "markdown");
        await rejectsWith(atlassian.listComments({ key: "nope" }), "invalid");
        await rejectsWith(atlassian.listComments({ key: "KAN-999" }), "not_found");
    });

    it("can read the latest comments, oldest of them first, for callers that cannot page", async () => {
        const { mock, atlassian } = setup();
        mock.data.comments["KAN-2"] = Array.from({ length: 45 }, (_, index) => ({ id: String(100 + index), author: ALICE, body: `c${index + 1}`, created: `2026-11-01T00:${String(index).padStart(2, "0")}:00.000+0000` }));
        const summary = ({ comments }) => [comments.items.length, comments.items[0].body, comments.items.at(-1).body, comments.total, comments.nextStart];
        assert.deepEqual(summary(await atlassian.getIssue({ key: "KAN-2" })), [30, "c1", "c30", 45, 30]);
        assert.equal(callsTo(mock, "listJiraIssueComments").at(-1).args.orderBy, "created");
        assert.deepEqual(summary(await atlassian.getIssue({ key: "KAN-2", newestComments: true })), [30, "c16", "c45", 45, null]);
        assert.equal(callsTo(mock, "listJiraIssueComments").at(-1).args.orderBy, "-created");
    });

    it("keeps a short discussion in order when it reads the latest comments", async () => {
        const { atlassian } = setup();
        const issue = await atlassian.getIssue({ key: "KAN-2", newestComments: true });
        assert.deepEqual(issue.comments.items.map((comment) => comment.body), ["a", "b", "c"]);
        assert.deepEqual([issue.comments.total, issue.comments.nextStart, issue.comments.error], [3, null, null]);
    });

    it("still shows the issue when the latest comments cannot be read", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("listJiraIssueComments", { statusCode: 500, message: "comments are down" });
        const issue = await atlassian.getIssue({ key: "KAN-2", newestComments: true });
        assert.deepEqual(issue.comments, { items: [], total: 0, nextStart: null, error: "comments are down" });
    });
});

describe("releases and components", () => {
    it("lists versions, newest release date first", async () => {
        const { atlassian } = setup();
        const { items } = await atlassian.listVersions({ space: "KAN" });
        assert.deepEqual(items.map((version) => [version.name, version.released, version.releaseDate]), [["2.0", false, "2026-12-01"], ["1.0", true, "2026-10-01"]]);
        assert.deepEqual((await atlassian.listVersions({ space: "SAM1" })).items, []);
    });

    it("lists components", async () => {
        const { atlassian } = setup();
        const { items } = await atlassian.listComponents({ space: "KAN" });
        assert.equal(items.length, 1);
        assert.deepEqual(items[0], { id: "30000", name: "Backend", description: "Services", lead: { id: ALICE.accountId, name: "Alice Martin", avatar: "https://avatar.example/alice/48" }, assignee: null, issueCount: 1 });
    });

    it("validates the space and reports a missing one", async () => {
        const { atlassian } = setup();
        await rejectsWith(atlassian.listVersions({ space: "" }), "invalid");
        await rejectsWith(atlassian.listComponents({ space: "x y" }), "invalid");
        await rejectsWith(atlassian.listVersions({ space: "ZZZ" }), "not_found");
    });

    it("says so on a toolset that cannot read them", async () => {
        await rejectsWith(setup({ layered: false }).atlassian.listVersions({ space: "KAN" }), "unsupported", /does not offer getJiraProjectVersions/);
    });
});

describe("Confluence", () => {
    it("lists the spaces by name, with absolute links", async () => {
        const { atlassian } = setup();
        const { items, hasMore } = await atlassian.listConfluenceSpaces();
        assert.equal(hasMore, false);
        assert.deepEqual(items.map((space) => [space.key, space.name, space.description, space.url]), [
            ["DOCS", "Documentation", "", `${SITE_URL}/wiki/spaces/DOCS`],
            ["ENG", "Engineering", "Engineering notes", `${SITE_URL}/wiki/spaces/ENG`],
        ]);
    });

    it("lists the spaces through the flat toolset too", async () => {
        const { mock, atlassian } = setup({ layered: false });
        assert.equal((await atlassian.listConfluenceSpaces()).items.length, 2);
        assert.ok(mock.calledTools().includes("getConfluenceSpaces"));
    });

    it("lists the pages of a space", async () => {
        const { mock, atlassian } = setup();
        const { items, total, nextCursor } = await atlassian.listConfluencePages({ space: "ENG" });
        assert.deepEqual(items.map((page) => page.title), ["Runbook", "Architecture", "Onboarding"]);
        assert.equal(total, 3);
        assert.equal(nextCursor, null);
        assert.equal(callsTo(mock, "searchConfluence")[0].args.cql, 'type = page AND space = "ENG" ORDER BY lastmodified DESC');
        assert.deepEqual(items[0], { id: "20001", title: "Runbook", type: "page", excerpt: "…Runbook …", space: { key: "ENG", name: "Engineering" }, modified: "2026-11-03T09:00:00.000Z", author: { id: ALICE.accountId, name: "Alice Martin", avatar: "https://avatar.example/alice/48" }, url: `${SITE_URL}/wiki/spaces/ENG/pages/20001` });
    });

    it("pages with the cursor of the next link", async () => {
        const { mock, atlassian } = setup({ pageCap: 2 });
        const first = await atlassian.listConfluencePages({ space: "ENG" });
        assert.deepEqual([first.items.length, first.nextCursor], [2, "2"]);
        const second = await atlassian.listConfluencePages({ space: "ENG", cursor: first.nextCursor });
        assert.deepEqual([second.items.map((page) => page.title), second.nextCursor], [["Onboarding"], null]);
        assert.equal(callsTo(mock, "searchConfluence").at(-1).args.cursor, "2");
    });

    it("searches pages and posts", async () => {
        const { mock, atlassian } = setup();
        const { items } = await atlassian.searchConfluence({ q: "runbook" });
        assert.deepEqual(items.map((page) => page.title).sort(), ["Onboarding", "Runbook"]);
        assert.equal(callsTo(mock, "searchConfluence")[0].args.cql, 'type in (page, blogpost) AND text ~ "runbook"');
        await atlassian.searchConfluence({ q: 'run"book*' });
        assert.equal(callsTo(mock, "searchConfluence").at(-1).args.cql, 'type in (page, blogpost) AND text ~ "run book"');
    });

    it("retries without `expand` when the server does not accept it", async () => {
        const { mock, atlassian } = setup();
        mock.state.rejectExpand = true;
        const { items } = await atlassian.listConfluencePages({ space: "ENG" });
        assert.equal(items.length, 3);
        const searches = callsTo(mock, "searchConfluence");
        assert.deepEqual(searches.map((call) => "expand" in call.args), [true, false]);
    });

    it("does not retry other failures", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("searchConfluence", { statusCode: 403, message: "no access" });
        await rejectsWith(atlassian.listConfluencePages({ space: "ENG" }), "forbidden");
        assert.equal(callsTo(mock, "searchConfluence").length, 1);
    });

    it("reads a page as Markdown", async () => {
        const { atlassian } = setup();
        const page = await atlassian.getConfluencePage({ id: "20001" });
        assert.equal(page.title, "Runbook");
        assert.equal(page.body, "# Runbook\n\nRestart the **service**.");
        assert.deepEqual(page.space, { key: "ENG", name: "Engineering" });
        assert.equal(page.author.name, "Alice Martin");
        assert.equal(page.url, `${SITE_URL}/wiki/spaces/ENG/pages/20001`);
        await rejectsWith(atlassian.getConfluencePage({ id: "99999" }), "not_found");
    });

    it("reads page bodies that come in other forms", async () => {
        const { mock, atlassian } = setup();
        const bodies = [
            [{ id: "20001", title: "T", body: { atlas_doc_format: { value: JSON.stringify(adf(paragraph(text("from adf")))) } } }, "from adf"],
            [{ id: "20001", title: "T", body: { storage: { value: "<p>Hi <b>there</b></p>" } } }, "Hi there"],
            [{ id: "20001", title: "T", body: "plain body" }, "plain body"],
            ["# Markdown only", "# Markdown only"],
            [{ id: "20001", title: "T" }, ""],
        ];
        for (const [data, expected] of bodies) {
            mock.failWith("getConfluenceContent", () => mock.ok(data));
            const page = await atlassian.getConfluencePage({ id: "20001" });
            assert.equal(page.body, expected, JSON.stringify(data));
            assert.equal(page.id, "20001");
        }
    });

    it("validates what it is given", async () => {
        const { atlassian } = setup();
        for (const id of [undefined, "", "abc", "12 34", "1".repeat(21), "../1"]) await rejectsWith(atlassian.getConfluencePage({ id }), "invalid", /page id/);
        for (const space of [undefined, "", "x".repeat(81)]) await rejectsWith(atlassian.listConfluencePages({ space }), "invalid", /Confluence space/);
        for (const q of [undefined, "", "   ", '()*"']) await rejectsWith(atlassian.searchConfluence({ q }), "invalid", /search for/);
    });

    it("quotes the space of a page list", async () => {
        const { mock, atlassian } = setup();
        await atlassian.listConfluencePages({ space: 'EN"G OR space = "X' });
        assert.equal(callsTo(mock, "searchConfluence")[0].args.cql, 'type = page AND space = "EN\\"G OR space = \\"X" ORDER BY lastmodified DESC');
    });

    it("copes with a site that has no content at all", async () => {
        const { mock, atlassian } = setup();
        mock.data.confluenceSpaces.length = 0;
        mock.data.confluencePages.length = 0;
        assert.deepEqual((await atlassian.listConfluenceSpaces()).items, []);
        assert.deepEqual(await atlassian.listConfluencePages({ space: "ENG" }).then(({ items, nextCursor, total }) => ({ items, nextCursor, total })), { items: [], nextCursor: null, total: 0 });
    });
});

describe("failures", () => {
    it("maps what Atlassian says to an error code", async () => {
        const { mock, atlassian } = setup();
        for (const [statusCode, code] of [[401, "auth"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [400, "invalid"], [503, "upstream"]]) {
            mock.failWith("searchJiraIssuesUsingJql", { statusCode, message: `HTTP ${statusCode}` });
            await rejectsWith(atlassian.searchIssues({ space: "KAN" }), code);
        }
    });

    it("turns a transport that throws into an upstream error", async () => {
        const mock = createMockAtlassian();
        const transport = { tools: mock.transport.tools, invoke: async () => { throw new Error("socket hang up"); } };
        await rejectsWith(createAtlassian({ transport }).listSpaces(), "upstream", /Calling getAccessibleAtlassianResources failed: socket hang up/);
    });

    it("does not remember a failed read", async () => {
        const { mock, atlassian } = setup();
        mock.failWith("listJiraProjects", { statusCode: 500, message: "boom" });
        await rejectsWith(atlassian.listSpaces(), "upstream");
        mock.clearFailures();
        assert.equal((await atlassian.listSpaces()).spaces.length, 2);
    });

    it("gives up on a call that never answers", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { mock, atlassian } = setup();
        mock.failWith("searchJiraIssuesUsingJql", () => new Promise(() => {}));
        const pending = atlassian.searchIssues({ space: "KAN" });
        for (let i = 0; i < 50 && !callsTo(mock, "searchJiraIssuesUsingJql").length; i++) await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(60_000);
        await rejectsWith(pending, "timeout", /did not answer searchJiraIssuesUsingJql/);
    });
});

describe("a request that gets lost", () => {
    const sentTo = (mock) => callsTo(mock, "getAccessibleAtlassianResources");
    const flush = async () => {
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    const until = async (condition, what) => {
        for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
        assert.ok(condition(), what);
    };
    const deferred = () => {
        const parts = {};
        parts.promise = new Promise((resolve, reject) => Object.assign(parts, { resolve, reject }));
        return parts;
    };
    // The site list is answered by the test, request by request; `sent` lists the requests that were made for it.
    const manual = () => {
        const mock = createMockAtlassian();
        mocks.push(mock);
        const sent = [];
        const transport = {
            tools: mock.transport.tools,
            invoke: (id, args) => {
                if (!id.endsWith("getAccessibleAtlassianResources")) return mock.transport.invoke(id, args);
                const request = deferred();
                request.answer = () => request.resolve(mock.transport.invoke(id, args));
                sent.push(request);
                return request.promise;
            },
        };
        return { sent, atlassian: createAtlassian({ transport, hedgeMs: 5_000 }) };
    };

    it("sends a read once more when nothing has answered it yet, and uses the answer that comes", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { mock, atlassian } = setup({ hedgeMs: 5_000 });
        let lost = false;
        mock.failWith("getAccessibleAtlassianResources", () => {
            if (lost) return undefined;
            lost = true;
            return new Promise(() => {});
        });
        const pending = atlassian.listSpaces();
        await until(() => sentTo(mock).length === 1, "the request was never sent");
        t.mock.timers.tick(4_999);
        await flush();
        assert.equal(sentTo(mock).length, 1, "it was sent again before the delay");
        t.mock.timers.tick(1);
        await until(() => sentTo(mock).length === 2, "it was never sent again");
        assert.equal((await pending).spaces.length, 2);
        assert.deepEqual(sentTo(mock)[1].args, sentTo(mock)[0].args);
        assert.equal(sentTo(mock).length, 2);
    });

    it("sends a read only once when the answer comes in time", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { mock, atlassian } = setup({ hedgeMs: 5_000 });
        await atlassian.listSpaces();
        const sent = mock.calls.length;
        t.mock.timers.tick(60_000);
        await flush();
        assert.equal(mock.calls.length, sent);
        assert.equal(sentTo(mock).length, 1);
    });

    it("does not send a read again when it failed before the delay", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { sent, atlassian } = manual();
        const pending = atlassian.listSpaces();
        await until(() => sent.length === 1, "the request was never sent");
        sent[0].reject(new Error("socket hang up"));
        await rejectsWith(pending, "upstream", /socket hang up/);
        t.mock.timers.tick(60_000);
        await flush();
        assert.equal(sent.length, 1);
    });

    it("uses the answer to the second request when the first one fails after it was sent", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { sent, atlassian } = manual();
        const pending = atlassian.listSpaces();
        await until(() => sent.length === 1, "the request was never sent");
        t.mock.timers.tick(5_000);
        await until(() => sent.length === 2, "it was never sent again");
        sent[0].reject(new Error("connection reset"));
        await flush();
        sent[1].answer();
        assert.equal((await pending).spaces.length, 2);
    });

    it("reports the first failure when both requests fail", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { sent, atlassian } = manual();
        const pending = atlassian.listSpaces();
        await until(() => sent.length === 1, "the request was never sent");
        t.mock.timers.tick(5_000);
        await until(() => sent.length === 2, "it was never sent again");
        sent[0].reject(new Error("first failure"));
        await flush();
        sent[1].reject(new Error("second failure"));
        await rejectsWith(pending, "upstream", /first failure/);
        assert.equal(sent.length, 2);
    });

    it("still gives up after the timeout when neither request answers", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const { sent, atlassian } = manual();
        const pending = atlassian.listSpaces();
        await until(() => sent.length === 1, "the request was never sent");
        t.mock.timers.tick(5_000);
        await until(() => sent.length === 2, "it was never sent again");
        t.mock.timers.tick(55_000);
        await rejectsWith(pending, "timeout", /did not answer getAccessibleAtlassianResources/);
        assert.equal(sent.length, 2);
    });

    it("only ever applies to the tools that read", () => {
        assert.deepEqual([...READ_TOOLS].sort(), [...ALLOWED_TOOLS].sort());
        for (const name of ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addOrEditJiraIssueComment", "createConfluenceContent", "updateConfluenceContent", "executeWrite", "executeDestructive"]) {
            assert.ok(!READ_TOOLS.includes(name), `${name} would be sent twice`);
        }
    });
});

describe("caching and concurrency", () => {
    it("caches slow reads for 30 seconds, and a refresh drops them", async () => {
        let clock = 0;
        const { mock, atlassian } = setup({ now: () => clock });
        await atlassian.listSpaces();
        await atlassian.listSpaces();
        assert.equal(callsTo(mock, "listJiraProjects").length, 1);
        clock += 31_000;
        await atlassian.listSpaces();
        assert.equal(callsTo(mock, "listJiraProjects").length, 2);
        atlassian.clearCache();
        await atlassian.listSpaces();
        assert.equal(callsTo(mock, "listJiraProjects").length, 3);
        assert.equal(callsTo(mock, "getAccessibleAtlassianResources").length, 2);
    });

    it("shares one request between identical reads that overlap", async () => {
        const { mock, atlassian } = setup();
        mock.stats.latency = 10;
        await Promise.all([atlassian.listSpaces(), atlassian.listSpaces(), atlassian.listSpaces()]);
        assert.equal(callsTo(mock, "listJiraProjects").length, 1);
    });

    it("never has more than four requests in flight", async () => {
        const { mock, atlassian } = setup();
        mock.stats.latency = 15;
        await atlassian.listSpaces();
        mock.stats.maxActive = 0;
        await Promise.all(["KAN-1", "KAN-2", "KAN-3", "KAN-4", "KAN-5", "KAN-6"].map((key) => atlassian.getIssue({ key })));
        assert.ok(mock.stats.maxActive > 1, `requests were serialized (${mock.stats.maxActive})`);
        assert.ok(mock.stats.maxActive <= 4, `too many requests at once (${mock.stats.maxActive})`);
    });
});

describe("diagnose", () => {
    it("reports the server, the sites and who is signed in", async () => {
        const { atlassian } = setup();
        const report = await atlassian.diagnose();
        assert.equal(report.server, "atlassian");
        assert.equal(report.layered, true);
        assert.ok(report.tools.includes("executeRead") && report.tools.includes("searchJiraIssuesUsingJql"));
        assert.deepEqual(report.tools, [...report.tools].sort());
        assert.deepEqual(report.sites, [{ cloudId: CLOUD_ID, url: SITE_URL, name: "acme", jira: true, confluence: true }]);
        assert.equal(report.site, SITE_URL);
        assert.equal(report.signedInAs, ALICE.accountId);
        assert.equal("error" in report, false);
    });

    it("names the signed-in user when the server says who it is, and otherwise gives the account ID", async () => {
        const mock = createMockAtlassian();
        mocks.push(mock);
        const answering = (answer) => createAtlassian({ transport: { tools: mock.transport.tools, invoke: (id, args) => (id.endsWith("atlassianUserInfo") ? answer : mock.transport.invoke(id, args)) } });
        const info = (user) => okResult(user);
        assert.equal((await answering(info({ accountId: "712020:abc", displayName: "Alice Martin" })).diagnose()).signedInAs, "Alice Martin");
        assert.equal((await answering(info({ account_id: "712020:abc", name: "Alice Martin" })).diagnose()).signedInAs, "Alice Martin");
        assert.equal((await answering(info({ account_id: "712020:abc" })).diagnose()).signedInAs, "712020:abc");
        assert.equal((await answering(info({})).diagnose()).signedInAs, null);
    });

    it("reports the problem instead of throwing when the sites cannot be read", async () => {
        const { atlassian } = setup({ sites: [] });
        const report = await atlassian.diagnose();
        assert.deepEqual(report.sites, []);
        assert.equal(report.error.code, "not_connected");
    });

    it("throws when there is no Atlassian server at all", async () => {
        const transport = { tools: async () => [], invoke: async () => ({ ok: true, text: "{}" }) };
        await rejectsWith(createAtlassian({ transport }).diagnose(), "not_connected");
    });
});

test("nothing in this file ever called a tool that writes", () => {
    assert.ok(mocks.length > 40, `only ${mocks.length} servers were used`);
    for (const mock of mocks) {
        for (const tool of mock.calledTools()) assert.ok(ALLOWED_TOOLS.includes(tool), `the canvas called ${tool}`);
        for (const operation of mock.calledOperations()) assert.ok(ALLOWED_OPERATIONS.includes(operation), `the canvas ran the executeRead operation ${operation}`);
    }
});
