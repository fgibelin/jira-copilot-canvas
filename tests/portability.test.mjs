// What ships has to work from a plain copy of its folder: that is all `scripts/install.mjs` copies for Copilot, and all the
// VSIX holds for VS Code. Nothing here touches the real ~/.copilot: every run gets its own HOME and COPILOT_HOME.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FOLDER = "jira-copilot-canvas";
const EXTENSION_DIR = path.join(ROOT, FOLDER);
const VSCODE_DIR = path.join(ROOT, "vscode");
const INSTALLER = path.join(ROOT, "scripts", "install.mjs");
const SUITE = { timeout: 60_000 };

const run = promisify(execFile);
const modulesIn = async (dir) => (await readdir(dir)).filter((name) => name.endsWith(".mjs")).sort();
const EXTENSION_MODULES = await modulesIn(EXTENSION_DIR);
const VSCODE_MODULES = await modulesIn(VSCODE_DIR);

// The tests may run from a git hook, where GIT_DIR and friends would redirect every `git -C` below.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const exists = (file) => lstat(file).then(() => true, () => false);

async function sandbox(t) {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "jira-canvas-install-")));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const home = path.join(dir, "home");
    await mkdir(home);
    const copilotHome = path.join(dir, "copilot-home");
    return {
        dir,
        home,
        env: { HOME: home, USERPROFILE: home, COPILOT_HOME: copilotHome, LC_ALL: "C" },
        userCopy: path.join(copilotHome, "extensions", FOLDER),
    };
}

async function repository(t) {
    const box = await sandbox(t);
    const repo = path.join(box.dir, "repo");
    await mkdir(path.join(repo, "packages", "app"), { recursive: true });
    execFileSync("git", ["init", "--quiet", repo], { env: cleanEnv(), stdio: "ignore" });
    return { ...box, repo, projectCopy: path.join(repo, ".github", "extensions", FOLDER) };
}

async function install(args, { cwd = ROOT, env }) {
    try {
        const { stdout, stderr } = await run(process.execPath, [INSTALLER, ...args], { cwd, env: { ...cleanEnv(), ...env }, encoding: "utf8", timeout: 30_000 });
        return { status: 0, stdout, stderr };
    } catch (error) {
        return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
}

// A fingerprint per file, so that two folders compare as equal only when every file is.
async function snapshot(dir) {
    const files = {};
    for (const relative of (await readdir(dir, { recursive: true })).sort()) {
        const file = path.join(dir, relative);
        if ((await lstat(file)).isFile()) files[relative.split(path.sep).join("/")] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
    return files;
}

describe("installing the extension for Copilot", SUITE, () => {
    test("copies the whole extension folder into the extensions of the user", async (t) => {
        const { home, env, userCopy } = await sandbox(t);
        const result = await install(["--user"], { env });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(userCopy), result.stdout);
        const copy = await snapshot(userCopy);
        assert.deepEqual(copy, await snapshot(EXTENSION_DIR));
        for (const required of ["extension.mjs", "copilot-extension.json", "public/index.html", "public/js/app.js"]) assert.ok(copy[required], `${required} is missing from the copy`);
        assert.equal(await exists(path.join(home, ".copilot")), false);
    });

    test("falls back to ~/.copilot when COPILOT_HOME is empty", async (t) => {
        const { home, env } = await sandbox(t);
        const result = await install(["--user"], { env: { ...env, COPILOT_HOME: "" } });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(await exists(path.join(home, ".copilot", "extensions", FOLDER, "extension.mjs")));
    });

    test("refuses to overwrite an installation that is already there", async (t) => {
        const { env, userCopy } = await sandbox(t);
        assert.equal((await install(["--user"], { env })).status, 0);
        const notes = path.join(userCopy, "notes.txt");
        await writeFile(notes, "mine");
        const again = await install(["--user"], { env });
        assert.equal(again.status, 1);
        assert.match(again.stderr, /Already installed at /);
        assert.equal(await readFile(notes, "utf8"), "mine");
        assert.ok(await exists(path.join(userCopy, "extension.mjs")));
    });

    test("does not write through a link that is in its way", { skip: process.platform === "win32" }, async (t) => {
        const { dir, env, userCopy } = await sandbox(t);
        const elsewhere = path.join(dir, "elsewhere");
        await mkdir(path.dirname(userCopy), { recursive: true });
        await symlink(elsewhere, userCopy);
        const result = await install(["--user"], { env });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Already installed at /);
        assert.equal(await exists(elsewhere), false);
    });

    test("installs into the root of the repository that holds the folder it is given", async (t) => {
        const { env, repo, projectCopy } = await repository(t);
        const result = await install(["--project", path.join(repo, "packages", "app")], { env });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await snapshot(projectCopy), await snapshot(EXTENSION_DIR));
        assert.equal(await exists(env.COPILOT_HOME), false);
    });

    test("reads a relative folder from where it is run", async (t) => {
        const { env, repo, projectCopy } = await repository(t);
        const result = await install(["--project", ".."], { cwd: path.join(repo, "packages", "app"), env });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(await exists(path.join(projectCopy, "extension.mjs")));
    });

    test("installs nothing outside a git repository", async (t) => {
        const { dir, env } = await sandbox(t);
        const plain = path.join(dir, "plain");
        await mkdir(plain);
        const result = await install(["--project", plain], { env: { ...env, GIT_CEILING_DIRECTORIES: dir } });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /not a git repository/i);
        assert.deepEqual(await readdir(plain), []);
    });

    test("installs nothing for a folder that does not exist", async (t) => {
        const { dir, env } = await sandbox(t);
        const missing = path.join(dir, "missing");
        const result = await install(["--project", missing], { env });
        assert.equal(result.status, 1);
        assert.equal(await exists(missing), false);
    });

    for (const args of [[], ["--user", "extra"], ["--project"], ["--project", "one", "two"], ["--bogus"], ["user"]]) {
        test(`explains how to use it, and installs nothing, for ${args.length ? `"${args.join(" ")}"` : "no arguments"}`, async (t) => {
            const { home, env } = await sandbox(t);
            const result = await install(args, { env });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /^Usage: node scripts\/install\.mjs --user \| --project \/path\/to\/git\/repository$/m);
            assert.equal(await exists(env.COPILOT_HOME), false);
            assert.deepEqual(await readdir(home), []);
        });
    }
});

describe("a plain copy of the extension folder", SUITE, () => {
    let root;
    const load = (name) => import(pathToFileURL(path.join(root, FOLDER, name)).href);

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "jira-canvas-copy-"));
        await cp(EXTENSION_DIR, path.join(root, FOLDER), { recursive: true });
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("has modules to check", () => {
        assert.ok(EXTENSION_MODULES.includes("extension.mjs"));
        assert.ok(EXTENSION_MODULES.length > 5, EXTENSION_MODULES.join(", "));
    });

    for (const name of EXTENSION_MODULES.filter((module) => module !== "extension.mjs")) {
        test(`loads ${name} with no Copilot SDK, no installed package and nothing outside the folder`, async () => {
            await load(name);
        });
    }

    test("needs nothing but the Copilot SDK to start the extension", async () => {
        await assert.rejects(load("extension.mjs"), (error) => {
            assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
            assert.match(error.message, /@github\/copilot-sdk/);
            return true;
        });
    });

    test("is named after the folder it is installed into", async () => {
        const manifest = JSON.parse(await readFile(path.join(root, FOLDER, "copilot-extension.json"), "utf8"));
        assert.equal(manifest.name, FOLDER);
    });
});

describe("the VS Code adapter in the layout of the package", SUITE, () => {
    let root;

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "jira-canvas-vsix-"));
        await cp(EXTENSION_DIR, path.join(root, FOLDER), { recursive: true });
        await cp(VSCODE_DIR, path.join(root, "vscode"), { recursive: true });
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("has modules to check", () => {
        assert.ok(VSCODE_MODULES.length >= 4, VSCODE_MODULES.join(", "));
    });

    for (const name of VSCODE_MODULES) {
        test(`loads ${name} with no Copilot SDK and no installed package`, async () => {
            await import(pathToFileURL(path.join(root, "vscode", name)).href);
        });
    }
});

describe("the Copilot extension process", SUITE, () => {
    test("never writes to stdout, which carries its connection to Copilot", async () => {
        const offenders = [];
        for (const name of EXTENSION_MODULES) {
            const lines = (await readFile(path.join(EXTENSION_DIR, name), "utf8")).split("\n");
            lines.forEach((line, index) => {
                if (/\bconsole\.(?!error\b|warn\b)\w+|\bprocess\.stdout\b/.test(line)) offenders.push(`${name}:${index + 1}`);
            });
        }
        assert.deepEqual(offenders, []);
    });
});
