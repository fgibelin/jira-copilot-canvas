import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
execFileSync("tar", ["-czf", "dist/jira-copilot-canvas.tar.gz", "-C", ".", "jira-copilot-canvas"], { cwd: root, stdio: "inherit" });
console.log("Created dist/jira-copilot-canvas.tar.gz (extract and install its jira-copilot-canvas/ directory).");
