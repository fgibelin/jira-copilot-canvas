import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../jira-copilot-canvas/public/js/vscode-bridge.js", import.meta.url), "utf8");

/**
 * Runs the bridge of the renderer in a context that has what a webview has: `acquireVsCodeApi`, `window` and timers
 * that only fire when told to. `onPost` gets a copy of every message that the page posts to the extension; `deliver`
 * is how the extension posts to the page.
 */
export function createRenderer({ onPost = () => {}, inVsCode = true } = {}) {
    const timers = new Map();
    const cleared = [];
    let listener;
    let timerCount = 0;
    let idCount = 0;
    const sandbox = {
        window: {
            addEventListener: (type, callback) => {
                if (type === "message") listener = callback;
            },
        },
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++idCount).padStart(12, "0")}` },
        setTimeout: (callback, ms) => {
            const id = ++timerCount;
            timers.set(id, {
                ms,
                fire: () => {
                    timers.delete(id);
                    callback();
                },
            });
            return id;
        },
        clearTimeout: (id) => {
            cleared.push(id);
            timers.delete(id);
        },
    };
    // A copy, because what a sandbox creates has the prototypes of the sandbox, which deepStrictEqual does not accept.
    if (inVsCode) sandbox.acquireVsCodeApi = () => ({ postMessage: (message) => onPost(JSON.parse(JSON.stringify(message))) });
    vm.runInNewContext(SOURCE.replace("export const bridge", "globalThis.bridge"), sandbox);
    return { bridge: sandbox.bridge, timers, cleared, deliver: (data) => listener({ data }) };
}
