#!/usr/bin/env node
// Fails when `src/shared/bindings.d.ts` is older than any input the
// tauri-specta codegen reads (Cargo.toml or any file under src-tauri/src/).
// Runs in CI so an out-of-date binding file blocks merge.

import { statSync, existsSync, readdirSync } from "node:fs";
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

if (stale.length > 0) {
    console.error(
        `error: ${relative(ROOT, BINDINGS)} is older than ${stale.length} input file(s).`,
    );
    console.error(
        "       Run `npm run generate:bindings` to regenerate the bindings before committing.",
    );
    for (const path of stale.slice(0, 10)) {
        console.error(`       - ${relative(ROOT, path)}`);
    }
    if (stale.length > 10) {
        console.error(`       ... and ${stale.length - 10} more`);
    }
    process.exit(1);
}

console.log(
    `ok: ${relative(ROOT, BINDINGS)} is at least as new as all ${inputs.length} backend input(s).`,
);
