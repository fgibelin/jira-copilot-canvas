import { buildActions } from "../jira-copilot-canvas/actions.mjs";

const toolName = (action) => `jira_canvas_${action.name}`;
const titleOf = (action) => `Jira: ${action.name.replaceAll("_", " ")}`;

// What `contributes.languageModelTools` in package.json must declare. `npm run sync-tools` writes it from here.
export function toolContributions() {
    return buildActions({
        workbenchFor: () => {
            throw new Error("Metadata only");
        },
    }).map((action) => ({
        name: toolName(action),
        displayName: titleOf(action),
        modelDescription: `${action.description} Works on the Jira canvas that is open in VS Code: open it first with "Jira: Open Jira Canvas".`,
        userDescription: action.description,
        canBeReferencedInPrompt: true,
        toolReferenceName: `jira_${action.name}`,
        when: "isWorkspaceTrusted",
        inputSchema: action.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
    }));
}

// Every tool reads or navigates; none writes to Jira. Starting a session from a work item stays a button in the panel.
export function registerTools(vscode, context, current, log) {
    const actions = buildActions({ workbenchFor: () => current().workbench, log });
    for (const action of actions) {
        context.subscriptions.push(
            vscode.lm.registerTool(toolName(action), {
                prepareInvocation() {
                    return { invocationMessage: titleOf(action) };
                },
                async invoke({ input }, cancellation) {
                    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
                    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before using the Jira tools.");
                    const result = await action.handler({ input });
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
                },
            }),
        );
    }
}
