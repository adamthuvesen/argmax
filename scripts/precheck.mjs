#!/usr/bin/env node
// The pre-push gate: the same checks CI runs, scoped to what the branch
// changed so the whole thing stays under a couple of minutes. `git push`
// runs it through `.githooks/pre-push`; `npm run precheck` runs it by hand.
//
//   node scripts/precheck.mjs            # scope from the diff against main
//   node scripts/precheck.mjs --all      # every lane, whatever changed
//   node scripts/precheck.mjs --base X   # diff against ref X instead of main
//
// Scope is decided from every file that differs from the merge base with
// main, committed or not, plus untracked files. Foreign edits in a shared
// checkout can only widen the scope, never hide a change.
//
// Each step runs to completion; the first failure ends the run with a
// non-zero exit so the push is refused. Long commands write straight to the
// terminal — nothing here pipes a build through `tail`, which would hide its
// exit code.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// `git push` exports GIT_DIR / GIT_INDEX_FILE into the hook. Cargo tests that
// seed a temp repo with `git init` then inherit those and lock this checkout's
// config instead of the fixture. Drop them so merge-base still uses cwd
// discovery, and the tests get a clean git.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX"
]) {
  delete process.env[key];
}

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CARGO_MANIFEST = "src-tauri/Cargo.toml";

const args = process.argv.slice(2);
const runEverything = args.includes("--all");
const baseIndex = args.indexOf("--base");
const requestedBase = baseIndex >= 0 ? args[baseIndex + 1] : null;
if (baseIndex >= 0 && !requestedBase) {
  console.error("error: --base needs a ref");
  process.exit(2);
}

function git(...gitArgs) {
  const run = spawnSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

function mergeBase() {
  const candidates = requestedBase ? [requestedBase] : ["origin/main", "main"];
  for (const candidate of candidates) {
    const base = git("merge-base", "HEAD", candidate);
    if (base) return { ref: candidate, sha: base };
  }
  return null;
}

function changedFiles(base) {
  const tracked = git("diff", "--name-only", base.sha) ?? "";
  const untracked = git("ls-files", "--others", "--exclude-standard") ?? "";
  return new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean));
}

const RUST_PATHS = [/^src-tauri\/(?!target\/)/, /^rust-toolchain\.toml$/];
const JS_PATHS = [
  /^src\//,
  /^package(-lock)?\.json$/,
  /^tsconfig\.json$/,
  /^vite(st)?(\.[\w-]+)?\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^scripts\//
];
const RENDERER_SOURCE = /^src\/(?!.*\.test\.tsx?$)/;

function touches(files, patterns) {
  for (const file of files) {
    if (patterns.some((pattern) => pattern.test(file))) return true;
  }
  return false;
}

function decideScope() {
  if (runEverything) {
    return { rust: true, js: true, bundle: true, reason: "--all" };
  }
  const base = mergeBase();
  if (!base) {
    return { rust: true, js: true, bundle: true, reason: "no main to diff against" };
  }
  const files = changedFiles(base);
  return {
    rust: touches(files, RUST_PATHS),
    js: touches(files, JS_PATHS),
    bundle: touches(files, [RENDERER_SOURCE]),
    reason: `${files.size} file(s) differ from ${base.ref}`
  };
}

function step(label, command, commandArgs) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  const run = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status !== 0) {
    console.error(`\nerror: ${label} failed after ${seconds}s (${command} ${commandArgs.join(" ")})`);
    process.exit(run.status ?? 1);
  }
  process.stdout.write(`✓ ${label} (${seconds}s)\n`);
}

const scope = decideScope();
const lanes = [scope.js && "js", scope.rust && "rust", scope.bundle && "bundle"].filter(Boolean);
if (lanes.length === 0) {
  console.log(`precheck: nothing to check (${scope.reason}).`);
  process.exit(0);
}
console.log(`precheck: ${lanes.join(" + ")} (${scope.reason})`);
const vitestBase = runEverything ? null : (mergeBase()?.sha ?? null);

// Contract checks are sub-second and cross the Rust/TS boundary, so they run
// whenever either side changed.
step("IPC channel parity", "node", ["scripts/check-tauri-bridge.mjs"]);
step("main-thread handler allowlist", "node", ["scripts/check-main-thread-handlers.mjs"]);

if (scope.js) {
  step("eslint", "npx", ["eslint", "."]);
  step("tsc", "npx", ["tsc", "--noEmit"]);
  // `--changed` runs only the test files whose import graph reaches a
  // changed file; a config or setup change widens it to the full suite.
  step(
    "vitest",
    "npx",
    vitestBase ? ["vitest", "run", "--changed", vitestBase] : ["vitest", "run"]
  );
  step("perf budgets", "npx", ["vitest", "run", "--config", "vitest.perf.config.ts", "--no-file-parallelism"]);
}

if (scope.rust) {
  step("cargo fmt", "cargo", ["fmt", "--manifest-path", CARGO_MANIFEST, "--check"]);
  step("cargo test", "cargo", ["test", "--manifest-path", CARGO_MANIFEST]);
  step("cargo clippy", "cargo", [
    "clippy",
    "--manifest-path",
    CARGO_MANIFEST,
    "--all-targets",
    "--",
    "-D",
    "warnings"
  ]);
}

if (scope.bundle) {
  step("renderer build", "npx", ["vite", "build"]);
  step("bundle budget", "node", ["scripts/check-bundle.mjs"]);
}

console.log("\nprecheck: all checks passed.");
