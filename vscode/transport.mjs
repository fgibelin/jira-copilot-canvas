// Transport used inside VS Code: the Atlassian MCP tools are the ones the editor already exposes to Copilot Chat
// (`vscode.lm.tools`), so the user's MCP sign-in is reused and no token is handled here.

// VS Code names an MCP tool `mcp_<server>_<tool>`. Atlassian tool names are camelCase, so the last underscore is the split.
const MCP_TOOL = /^(?:mcp_)?(.+)_([A-Za-z][A-Za-z0-9]*)$/;

export function parseToolName(name) {
    const match = MCP_TOOL.exec(typeof name === "string" ? name : "");
    return match ? { server: match[1], name: match[2] } : null;
}

// The canvas registers its own tools (see tools.mjs); they are not Atlassian tools.
const OWN_TOOLS = "jira_canvas_";

const decoder = new TextDecoder();

/**
 * Reads what `vscode.lm.invokeTool` returned. The first text part is the compact JSON block. The richer block arrives as
 * a JSON data part or as a second text part, depending on the VS Code version.
 */
export function normalizeToolResult(result) {
    const parts = Array.isArray(result?.content) ? result.content : [];
    const texts = parts.filter((part) => typeof part?.value === "string").map((part) => part.value);
    const data = parts.find((part) => part?.data instanceof Uint8Array && /json/i.test(String(part.mimeType)));
    return { ok: true, text: texts[0] ?? "", structured: data ? decoder.decode(data.data) : (texts[1] ?? null) };
}

/** @param {typeof import("vscode")} vscode */
export function createVsCodeTransport(vscode) {
    return {
        async tools() {
            return (vscode.lm?.tools ?? []).flatMap((tool) => {
                const parsed = tool.name.startsWith(OWN_TOOLS) ? null : parseToolName(tool.name);
                return parsed ? [{ id: tool.name, ...parsed }] : [];
            });
        },
        async invoke(id, args) {
            const cancellation = new vscode.CancellationTokenSource();
            try {
                return normalizeToolResult(await vscode.lm.invokeTool(id, { input: args, toolInvocationToken: undefined }, cancellation.token));
            } catch (error) {
                const message = error?.message ?? String(error);
                return { ok: false, text: message, structured: null, error: message };
            } finally {
                cancellation.dispose();
            }
        },
    };
}
