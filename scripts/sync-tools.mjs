import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { toolContributions } from "../vscode/tools.mjs";

const file = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(file, "utf8"));
const tools = toolContributions();
if (process.argv.includes("--check")) assert.deepEqual(manifest.contributes.languageModelTools, tools, "Run npm run sync-tools");
else {
    manifest.contributes.languageModelTools = tools;
    await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}
