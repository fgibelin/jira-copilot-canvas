// Starts a conversation from a work item inside VS Code.
//
// An extension cannot create a Copilot agent session with a ready-made prompt, so the work item goes into the input of a
// fresh Copilot Chat and the user sends it. That is deliberate: Jira text is untrusted, and nothing should reach an agent
// without a person pressing Enter.
import { AtlassianError } from "../jira-copilot-canvas/atlassian.mjs";

const TARGET = Object.freeze({ id: "chat", kind: "chat", label: "New chat in VS Code", detail: "The prompt is filled in; nothing is sent until you press Enter" });

/** @param {typeof import("vscode")} vscode */
export function createVsCodeLauncher(vscode, { log = () => {} } = {}) {
    const run = (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args));

    async function fillChat(prompt) {
        const attempts = [{ query: prompt, isPartialQuery: true, mode: "agent" }, { query: prompt, isPartialQuery: true }];
        for (const options of attempts) {
            try {
                await run("workbench.action.chat.open", options);
                return "prefilled";
            } catch (error) {
                log("warning", `workbench.action.chat.open failed: ${error?.message ?? error}`);
            }
        }
        await vscode.env.clipboard.writeText(prompt);
        await run("workbench.action.chat.open").catch(() => {});
        return "clipboard";
    }

    return {
        async targets() {
            return [{ ...TARGET }];
        },

        async launch({ target, name, prompt }) {
            if (target !== TARGET.id) throw new AtlassianError("invalid", "Choose where the session should start.");
            await run("workbench.action.chat.newChat").catch((error) => log("warning", `Could not start a new chat: ${error?.message ?? error}`));
            const delivery = await fillChat(prompt);
            const message =
                delivery === "prefilled"
                    ? `Copilot Chat is open with “${name}”. Review the prompt, then press Enter to send it.`
                    : `The prompt for “${name}” is on your clipboard. Open Copilot Chat and paste it.`;
            return { sessionId: "", navigated: true, target: TARGET.id, delivery, message };
        },
    };
}
