// Transport used inside the Copilot app: the Atlassian MCP tools are reached through the RPC of the session the
// extension joined, so the user's existing Atlassian sign-in is reused and no token is handled here.

export function normalizeToolResult(result) {
    if (typeof result === "string") return { ok: true, text: result, structured: null };
    const resultType = result?.resultType;
    const ok = resultType === undefined ? !result?.error : resultType === "success";
    const block = Array.isArray(result?.contents) ? result.contents.find((part) => part?.type === "text" && typeof part.text === "string") : null;
    const text = block?.text ?? (typeof result?.textResultForLlm === "string" ? result.textResultForLlm : "");
    return { ok, text, structured: result?.structuredContent ?? null, error: typeof result?.error === "string" ? result.error : undefined };
}

/** @param {{ getSession: () => any }} options `getSession` is read lazily because the session joins after the module loads. */
export function createCopilotTransport({ getSession }) {
    const rpc = () => getSession()?.rpc?.tools;
    return {
        async tools() {
            const tools = rpc();
            if (typeof tools?.getCurrentMetadata !== "function") throw new Error("this version of Copilot does not expose the session tools");
            const metadata = await tools.getCurrentMetadata();
            return (metadata?.tools ?? [])
                .filter((tool) => tool?.name && tool?.mcpServerName && tool?.mcpToolName)
                .map((tool) => ({ id: tool.name, server: tool.mcpServerName, name: tool.mcpToolName }));
        },
        async invoke(id, args) {
            const tools = rpc();
            if (typeof tools?.execute !== "function") throw new Error("this version of Copilot cannot run session tools from an extension");
            return normalizeToolResult(await tools.execute({ name: id, arguments: args }));
        },
    };
}
