import { cp, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let base;
if (args.length === 1 && args[0] === "--user") base = path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "extensions");
else if (args.length === 2 && args[0] === "--project") {
    const root = execFileSync("git", ["-C", path.resolve(args[1]), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    base = path.join(root, ".github", "extensions");
} else {
    console.error("Usage: node scripts/install.mjs --user | --project /path/to/git/repository");
    process.exit(1);
}
const destination = path.join(base, "jira-copilot-canvas");
try {
    await lstat(destination);
    throw new Error(`Already installed at ${destination}. Move or remove that copy explicitly before reinstalling.`);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
await mkdir(base, { recursive: true });
await cp(fileURLToPath(new URL("../jira-copilot-canvas/", import.meta.url)), destination, { recursive: true, force: false, errorOnExist: true });
console.log(`Installed the Jira canvas at ${destination}. Start a new Copilot session to load it.`);
