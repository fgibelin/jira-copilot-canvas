// Stand-in for @github/copilot-sdk/extension: records what the extension declares so tests can drive it directly.
export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export const createCanvas = (definition) => definition;

// `toolCalls` records every tool the extension runs through session.rpc.tools.execute.
// `toolHandler(request)` decides the result and `metadataHandler()` what getCurrentMetadata returns.
export const captured = { config: null, session: null, logs: [], toolCalls: [], toolHandler: null, metadataHandler: null };

export async function joinSession(config) {
    captured.config = config;
    captured.session = {
        sessionId: "test-session",
        workingDirectory: undefined,
        log: async (message, options) => {
            captured.logs.push({ message, ...options });
        },
        rpc: {
            tools: {
                getCurrentMetadata: async () => (captured.metadataHandler ? captured.metadataHandler() : { tools: [] }),
                execute: async (request) => {
                    captured.toolCalls.push(request);
                    return captured.toolHandler ? captured.toolHandler(request) : "ok";
                },
            },
        },
    };
    return captured.session;
}
