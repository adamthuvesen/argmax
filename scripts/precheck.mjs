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

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CARGO_MANIFEST = "src-tauri/Cargo.toml";
const ZERO_SHA = "0000000000000000000000000000000000000000";

const args = process.argv.slice(2);
const runEverything = args.includes("--all");
const baseIndex = args.indexOf("--base");
const requestedBase = baseIndex >= 0 ? args[baseIndex + 1] : null;
if (baseIndex >= 0 && !requestedBase) {
  console.error("error: --base needs a ref");
  process.exit(2);
}

// When called from git's pre-push hook, positional args are [remote_name, remote_url].
const targetRemote = args[0] && !args[0].startsWith("-") ? args[0] : null;

function git(...gitArgs) {
  const run = spawnSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });
  return run.status === 0 ? run.stdout : null;
}

function parsePushStdin() {
  if (process.stdin.isTTY) return null;
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!input.trim()) {
    // If called with a target remote argument from git, git invoked the hook
    // with 0 refs (e.g. non-fast-forward rejected ref updates or empty push).
    return targetRemote ? [] : null;
  }
  const lines = input.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 4) {
      entries.push({
        localRef: parts[0],
        localSha: parts[1],
        remoteRef: parts[2],
        remoteSha: parts[3]
      });
    }
  }
  return entries;
}

function mergeBase(headRef = "HEAD", remote = null) {
  const primaryRemote = remote || "origin";
  const candidates = requestedBase
    ? [requestedBase]
    : [`${primaryRemote}/main`, "origin/main", "main"];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const base = git("merge-base", headRef, candidate);
    if (base) return { ref: candidate, sha: base.trim() };
  }
  if (requestedBase) {
    console.error(`error: cannot find a merge base with ${requestedBase}`);
    process.exit(2);
  }
  return null;
}

function changedFiles(base) {
  const tracked = git("diff", "--name-only", "-z", base.sha);
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  if (tracked === null || untracked === null) {
    console.error("error: cannot determine changed files");
    process.exit(1);
  }
  return new Set(`${tracked}${untracked}`.split("\0").filter(Boolean));
}

const IOS_PATHS = [/^ios\//];
const RUST_PATHS = [
  /^src-tauri\/(?!target\/)/,
  /^assets\/browser-blocking\//,
  /^\.cargo\//,
  /^rust-toolchain\.toml$/,
  /^\.github\/workflows\//
];
const JS_PATHS = [
  /^src\//,
  /^src-tauri\/(?!target\/)/,
  /^ios\//,
  /^assets\//,
  /^public\//,
  /^(index|mobile)\.html$/,
  /^package(-lock)?\.json$/,
  /^tsconfig\.json$/,
  /^vite(st)?(\.[\w-]+)?\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^scripts\//,
  /^\.github\/workflows\//
];
const INERT_PATHS = [
  /^docs\//,
  /^\.githooks\//,
  /^[^/]*\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/
];

function touches(files, patterns) {
  for (const file of files) {
    if (patterns.some((pattern) => pattern.test(file))) return true;
  }
  return false;
}

function scopeForFiles(files, reason, vitestBase) {
  const hasUnclassifiedPath = files.size === 0 || [...files].some((file) =>
    !touches([file], [...RUST_PATHS, ...JS_PATHS, ...IOS_PATHS, ...INERT_PATHS])
  );
  const rust = hasUnclassifiedPath || touches(files, RUST_PATHS);
  const js = hasUnclassifiedPath || touches(files, JS_PATHS);
  return {
    rust,
    js,
    bundle: js,
    ios: touches(files, IOS_PATHS),
    reason: hasUnclassifiedPath ? `${reason}; unclassified path` : reason,
    vitestBase
  };
}

function decideScope() {
  if (runEverything) {
    return { rust: true, js: true, bundle: true, ios: true, reason: "--all", vitestBase: null };
  }

  const pushEntries = parsePushStdin();
  if (pushEntries !== null) {
    if (pushEntries.length === 0) {
      console.log("precheck: no refs to push, skipping checks.");
      process.exit(0);
    }

    const isDelete = (entry) =>
      entry.localSha === ZERO_SHA || entry.localRef === "(delete)" || !entry.localRef;
    if (pushEntries.every(isDelete)) {
      console.log("precheck: deleting remote ref, skipping checks.");
      process.exit(0);
    }

    const activeEntries = pushEntries.filter((entry) => !isDelete(entry));
    const files = new Set();
    let vitestBase = null;

    for (const entry of activeEntries) {
      let baseSha = null;
      if (entry.remoteSha && entry.remoteSha !== ZERO_SHA) {
        const common = git("merge-base", entry.localSha, entry.remoteSha);
        baseSha = common ? common.trim() : entry.remoteSha;
      } else {
        const base = mergeBase(entry.localSha, targetRemote);
        baseSha = base?.sha ?? null;
      }

      if (baseSha) {
        if (!vitestBase) vitestBase = baseSha;
        const tracked = git("diff", "--name-only", "-z", baseSha, entry.localSha);
        if (tracked !== null) {
          for (const file of tracked.split("\0").filter(Boolean)) {
            files.add(file);
          }
        }
      } else {
        return {
          rust: true,
          js: true,
          bundle: true,
          ios: true,
          reason: `cannot find merge base for ${entry.localRef}`,
          vitestBase: null
        };
      }
    }

    return scopeForFiles(
      files,
      `${files.size} file(s) differ across ${activeEntries.length} push ref(s)`,
      vitestBase
    );
  }

  const base = mergeBase("HEAD", targetRemote);
  if (!base) {
    return { rust: true, js: true, bundle: true, ios: true, reason: "no main to diff against", vitestBase: null };
  }
  const files = changedFiles(base);
  return scopeForFiles(files, `${files.size} file(s) differ from ${base.ref}`, base.sha);
}

function step(label, command, commandArgs) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  const run = spawnSync(command, commandArgs, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status !== 0) {
    console.error(`\nerror: ${label} failed after ${seconds}s (${command} ${commandArgs.join(" ")})`);
    process.exit(run.status ?? 1);
  }
  process.stdout.write(`✓ ${label} (${seconds}s)\n`);
}

const scope = decideScope();
const lanes = [scope.js && "js", scope.rust && "rust", scope.bundle && "bundle", scope.ios && "ios"].filter(
  Boolean
);
if (lanes.length === 0) {
  console.log(`precheck: nothing to check (${scope.reason}).`);
  process.exit(0);
}
console.log(`precheck: ${lanes.join(" + ")} (${scope.reason})`);
const vitestBase = runEverything ? null : scope.vitestBase;

// Contract checks are sub-second and cross the Rust/TS boundary, so they run
// whenever either side changed.
step("IPC channel parity", "node", ["scripts/check-tauri-bridge.mjs"]);
step("main-thread handler allowlist", "node", ["scripts/check-main-thread-handlers.mjs"]);

if (scope.js) {
  step("eslint", "npx", ["eslint", ".", "--cache", "--cache-location", "node_modules/.cache/eslint/"]);
  // TypeScript 7 (the `typescript-7` alias); see docs/testing.md.
  step("tsc", "node", ["node_modules/typescript-7/bin/tsc", "--noEmit"]);
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

// Seconds, and no Xcode: the phone app's whole build is not a pre-push gate,
// but a font named outside the type roles is caught by reading the source.
if (scope.ios) {
  step("iOS typography", "node", ["scripts/check-ios-fonts.mjs"]);
}

if (scope.bundle) {
  step("renderer build", "npx", ["vite", "build"]);
  step("bundle budget", "node", ["scripts/check-bundle.mjs"]);
}

console.log("\nprecheck: all checks passed.");
