// VS Code owns this bridge: a webview cannot reach the loopback server, so the extension relays requests for it.
// The Copilot app keeps using plain HTTP and SSE.
const CHANNEL = "jira-canvas";

function createBridge() {
    const host = acquireVsCodeApi();
    const pending = new Map();
    let events = null;
    window.addEventListener("message", ({ data }) => {
        if (data?.channel !== CHANNEL) return;
        if (data.type === "event") {
            events?.(data.event, data.data);
            return;
        }
        const call = pending.get(data.id);
        if (!call) return;
        pending.delete(data.id);
        clearTimeout(call.timer);
        call.resolve(data);
    });
    return {
        request(method, path, query, body) {
            return new Promise((resolve, reject) => {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("The extension did not respond. Refresh and try again."));
                }, 180_000);
                pending.set(id, { resolve, timer });
                host.postMessage({ channel: CHANNEL, type: "request", id, method, path, query, body });
            });
        },
        connect(onEvent, onStatus) {
            events = (event, data) => {
                if (event === "hello") onStatus("live");
                onEvent(event, data);
            };
            onStatus("connecting");
            host.postMessage({ channel: CHANNEL, type: "subscribe" });
            return () => {
                events = null;
                onStatus("closed");
            };
        },
    };
}

export const bridge = typeof acquireVsCodeApi === "function" ? createBridge() : null;
