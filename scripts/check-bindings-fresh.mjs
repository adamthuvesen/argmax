#!/usr/bin/env node
// Fails when `src/shared/bindings.d.ts` does not match what the tauri-specta
// codegen would emit for the current `src-tauri` sources. Runs in CI so an
// out-of-date binding file blocks merge.
//
// Locally, mtime is the cheap pre-filter, not the verdict. A rebase, a `git
// checkout`, a `touch`, or another agent editing this checkout all move input
// mtimes without changing a single exported type, and failing on that trains
// people to regenerate reflexively. That stamps someone else's in-flight Rust
// into their diff. When mtime trips, regenerate to a temp file and compare
// bytes: only a real difference fails.
//
// In CI the pre-filter is skipped entirely. A fresh clone writes every file in
// one checkout in sorted path order, and `src-tauri/…` sorts before
// `src/shared/bindings.d.ts` (`-` < `/`), so the bindings are always the newer
// file and the filter would wave every run through. CI compares bytes on every
// run, and an exporter that cannot run there is a failure, not a pass.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BINDINGS = join(ROOT, "src/shared/bindings.d.ts");
const CARGO_TOML = join(ROOT, "src-tauri/Cargo.toml");
const SRC_TAURI_SRC = join(ROOT, "src-tauri/src");

if (!existsSync(BINDINGS)) {
    console.error(`error: ${relative(ROOT, BINDINGS)} is missing.`);
    console.error(
        "       Run the Tauri app once in debug mode to regenerate it, or check it in as an empty placeholder.",
    );
    process.exit(1);
}

const bindingsMtime = statSync(BINDINGS).mtimeMs;

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "target" || entry.name === "gen") continue;
            out.push(...walk(path));
        } else if (entry.isFile()) {
            out.push(path);
        }
    }
    return out;
}

const inputs = [CARGO_TOML];
if (existsSync(SRC_TAURI_SRC)) inputs.push(...walk(SRC_TAURI_SRC));

const stale = inputs.filter((path) => {
    if (!existsSync(path)) return false;
    return statSync(path).mtimeMs > bindingsMtime;
});

/**
 * Re-run the exporter into a scratch file and compare it byte-for-byte with the
 * checked-in bindings.
 *
 * Returns `"match"`, `"differ"`, or `"unavailable"` when the exporter could not
 * run at all (no cargo, compile error). An unavailable exporter is not a pass:
 * the caller fails rather than waving the check through on a toolchain problem.
 */
function compareGeneratedBindings() {
    const scratch = mkdtempSync(join(tmpdir(), "argmax-bindings-"));
    const generated = join(scratch, "bindings.d.ts");
    try {
        const run = spawnSync(
            "cargo",
            [
                "run",
                "--quiet",
                "--manifest-path",
                join(ROOT, "src-tauri/Cargo.toml"),
                "--bin",
                "export-bindings",
                "--",
                generated,
            ],
            { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
        if (run.status !== 0 || !existsSync(generated)) {
            return { verdict: "unavailable", detail: (run.stderr ?? "").trim() };
        }
        return {
            verdict:
                readFileSync(generated, "utf8") === readFileSync(BINDINGS, "utf8")
                    ? "match"
                    : "differ",
        };
    } catch (error) {
        return { verdict: "unavailable", detail: String(error) };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

const inCI = Boolean(process.env.CI);

if (!inCI && stale.length === 0) {
    console.log(
        `ok: ${relative(ROOT, BINDINGS)} is at least as new as all ${inputs.length} backend input(s).`,
    );
    process.exit(0);
}

const { verdict, detail } = compareGeneratedBindings();

if (verdict === "match") {
    console.log(
        stale.length > 0
            ? `ok: ${relative(ROOT, BINDINGS)} matches the current backend types ` +
                  `(${stale.length} input file(s) are newer, but no exported type changed).`
            : `ok: ${relative(ROOT, BINDINGS)} matches the current backend types.`,
    );
    process.exit(0);
}

console.error(
    verdict === "differ"
        ? `error: ${relative(ROOT, BINDINGS)} does not match the current backend types.`
        : `error: could not verify ${relative(ROOT, BINDINGS)} because the exporter did not run.`,
);
console.error(
    "       Run `npm run generate:bindings` to regenerate the bindings before committing.",
);
if (detail) {
    console.error(`       exporter: ${detail.split("\n").slice(-3).join(" / ")}`);
}
for (const path of stale.slice(0, 10)) {
    console.error(`       - ${relative(ROOT, path)}`);
}
if (stale.length > 10) {
    console.error(`       ... and ${stale.length - 10} more`);
}
process.exit(1);
