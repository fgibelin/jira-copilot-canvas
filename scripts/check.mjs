import { readdir, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

async function check(dir) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
        const url = new URL(file.name + (file.isDirectory() ? "/" : ""), dir);
        if (file.isDirectory()) await check(url);
        else if (/\.(?:mjs|cjs|js)$/.test(file.name)) execFileSync(process.execPath, ["--check", fileURLToPath(url)], { stdio: "inherit" });
    }
}

for (const name of ["jira-copilot-canvas", "vscode", "scripts", "tests"]) await check(new URL(`${name}/`, root));
await mkdir(new URL("dist/", root), { recursive: true });
