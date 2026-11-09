// The lockfile is what CI and every contributor install from, so it has to stay usable outside this machine and in step with
// package.json. The extension itself has no runtime dependencies: the VSIX is built with --no-dependencies.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const pkg = await read("package.json");
const lock = await read("package-lock.json");

const root = lock.packages[""];
const installed = Object.entries(lock.packages).filter(([location]) => location !== "");
const downloaded = installed.filter(([, entry]) => !entry.link);

// "11.0.1" against "11.0.1" or later, comparing numbers rather than strings so that 11.10.0 is later than 11.9.0.
function atLeast(version, minimum) {
    const have = version.split("-")[0].split(".").map(Number);
    const need = minimum.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) if (have[index] !== need[index]) return have[index] > need[index];
    return true;
}

describe("package-lock.json", () => {
    test("describes this package and the dev dependencies that package.json asks for", () => {
        assert.equal(lock.lockfileVersion, 3);
        assert.equal(lock.name, pkg.name);
        assert.equal(lock.version, pkg.version);
        assert.equal(root.name, pkg.name);
        assert.equal(root.version, pkg.version);
        assert.deepEqual(root.devDependencies, pkg.devDependencies);
        assert.deepEqual(root.dependencies ?? {}, pkg.dependencies ?? {});
    });

    test("lists packages to install", () => {
        assert.ok(downloaded.length > 50, `only ${downloaded.length} packages`);
    });

    test("downloads every package from the public npm registry, not from a private feed", () => {
        const elsewhere = downloaded.filter(([, entry]) => !String(entry.resolved).startsWith("https://registry.npmjs.org/")).map(([location, entry]) => `${location} -> ${entry.resolved}`);
        assert.deepEqual(elsewhere, []);
    });

    test("pins every downloaded package to a sha512 checksum", () => {
        const unpinned = downloaded.filter(([, entry]) => !/^sha512-[A-Za-z0-9+/]{86}==$/.test(String(entry.integrity))).map(([location]) => location);
        assert.deepEqual(unpinned, []);
    });
});

describe("what ships in the extension", () => {
    test("needs no installed package at run time", () => {
        assert.deepEqual(pkg.dependencies ?? {}, {});
    });

    test("is packaged without node_modules", () => {
        assert.match(pkg.scripts["package:vscode"], /--no-dependencies/);
    });
});

describe("the minimatch override in package.json", () => {
    const minimum = String(pkg.overrides?.minimatch ?? "").replace(/^[\^~]/, "");
    const copies = installed.filter(([location]) => location === "node_modules/minimatch" || location.endsWith("/node_modules/minimatch"));

    test("asks for a plain version number", () => {
        assert.match(minimum, /^\d+\.\d+\.\d+$/);
    });

    test("is used by every copy of minimatch in the tree", () => {
        assert.ok(copies.length > 0, "minimatch is not installed at all");
        const older = copies.filter(([, entry]) => !atLeast(entry.version, minimum)).map(([location, entry]) => `${location}@${entry.version}`);
        assert.deepEqual(older, []);
    });
});
