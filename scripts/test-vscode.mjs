import { runTests } from "@vscode/test-electron";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const profile = await mkdtemp(path.join(tmpdir(), "jira-canvas-vscode-"));
try {
    await runTests({
        vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
        extensionDevelopmentPath: process.env.VSCODE_EXTENSION_PATH || fileURLToPath(new URL("../", import.meta.url)),
        extensionTestsPath: fileURLToPath(new URL("../tests/vscode-integration.cjs", import.meta.url)),
        launchArgs: [
            "--user-data-dir", path.join(profile, "user"),
            "--extensions-dir", path.join(profile, "extensions"),
            "--disable-extensions", "--skip-welcome", "--skip-release-notes",
        ],
    });
} finally {
    await rm(profile, { recursive: true, force: true });
}
