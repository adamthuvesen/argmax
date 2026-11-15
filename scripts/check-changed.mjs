#!/usr/bin/env node
// The fast feedback loop for any agent client. Checks only what changed, and
// each line of output says what is wrong and what to do.
//
//   npm run check:changed                # files that differ from main
//   npm run check:changed -- src/a.ts    # named files
//
// The hooks in scripts/agent-hooks call the same functions.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = JSON.parse(readFileSync(resolve(ROOT, "scripts/generated-files.json"), "utf8"));

function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function runNode(script, ...args) {
  return run(process.execPath, [script, ...args]);
}

function outputLines(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/** Checks fast enough to run after every edit. Returns lines an agent can act on. */
export function checkFile(path, { fast = false } = {}) {
  if (!existsSync(resolve(ROOT, path))) return [];
  const generated = GENERATED.find(({ pattern }) => new RegExp(pattern).test(path));
  if (generated) return [`${path} is generated. Change its source, then run: ${generated.run}`];
  const problems = [];
  if (path.endsWith(".rs") && path.startsWith("src-tauri/")) {
    if (
      run("rustfmt", ["--check", "--edition", "2021", "--config", "skip_children=true", path])
        .status === 1
    ) {
      problems.push(`${path}: not formatted. Run: cargo fmt --manifest-path src-tauri/Cargo.toml`);
    }
    const boundaries = runNode("scripts/check-rust-boundaries.mjs");
    if (boundaries.status !== 0) {
      const inFile = outputLines(boundaries).filter((line) => line.startsWith(path));
      problems.push(...inFile);
    }
  }
  if (path.endsWith(".swift")) {
    const fonts = runNode("scripts/check-ios-fonts.mjs");
    if (fonts.status !== 0)
      problems.push(
        ...outputLines(fonts).filter((line) => line.includes(path) || line.includes("Fix")),
      );
  }
  if (!fast && /\.(ts|tsx)$/.test(path) && path.startsWith("src/")) {
    const related = run("npx", [
      "--no-install",
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
      "--reporter=dot",
      path,
    ]);
    if (related.status !== 0) {
      problems.push(`${path}: related tests fail. Run: npx vitest related --run ${path}`);
      problems.push(
        ...outputLines(related)
          .filter((line) => /FAIL|AssertionError|Error:/.test(line))
          .slice(0, 12),
      );
    }
  }
  return problems;
}

function commandFailure(result, command) {
  if (result.error) return [`${command} could not run: ${result.error.message}`];
  if (result.signal) return [`${command} stopped by ${result.signal}. Run the check again.`];
  return [];
}

function checkTypescript(files) {
  const result = runNode("node_modules/typescript/bin/tsc", "--noEmit");
  if (result.status === 0) return [];
  const failure = commandFailure(result, "TypeScript");
  if (failure.length) return failure;
  const lines = outputLines(result);
  const diagnostics = lines.filter((line) => /^.+\(\d+,\d+\): error TS\d+:/.test(line));
  const globalErrors = lines.filter(
    (line) => !diagnostics.includes(line) && /error|Error/.test(line),
  );
  if (!diagnostics.length && !globalErrors.length)
    return ["TypeScript failed. Run: npm run typecheck", ...lines];
  return [
    ...diagnostics.filter((line) => files.some((file) => line.startsWith(`${file}(`))),
    ...globalErrors,
  ];
}

function checkLint(files) {
  const lintable = files.filter((file) => /\.(ts|tsx)$/.test(file) && file.startsWith("src/"));
  if (!lintable.length) return [];
  const result = runNode("scripts/lint.mjs", ...lintable);
  if (result.status === 0) return [];
  const failure = commandFailure(result, "oxlint");
  return failure.length
    ? failure
    : outputLines(result).filter((line) => !/^error: \d+ lint problems?\.$/.test(line));
}

function checkDependencies(files) {
  const sources = files.filter(
    (file) => /^src\/.*\.(ts|tsx)$/.test(file) && existsSync(resolve(ROOT, file)),
  );
  if (!sources.length) return [];
  const result = run(process.execPath, [
    "--import",
    "./scripts/typescript-5-hook.mjs",
    "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
    "--ignore-known",
    "--output-type",
    "err-long",
    ...sources,
  ]);
  return result.status === 0
    ? []
    : outputLines(result).filter((line) => !/^(?:x \d+ dependency violations|‼)/.test(line));
}

/** A file nobody has edited cannot hold a peer's unfinished work, so its errors are this change's. */
function isOwnedError(line, files) {
  const path = `src-tauri/${line.split(":")[0]}`;
  return files.includes(path) || run("git", ["diff", "--quiet", "HEAD", "--", path]).status === 0;
}

function checkRustCompiles(files) {
  if (!files.some((file) => file.endsWith(".rs"))) return [];
  const result = run("cargo", [
    "check",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--workspace",
    "--message-format",
    "short",
  ]);
  if (result.status === 0) return [];
  const failure = commandFailure(result, "cargo check");
  if (failure.length) return failure;
  const lines = outputLines(result);
  const diagnostics = lines.filter((line) => /^.+\.rs:\d+:\d+: error/.test(line));
  const globalErrors = lines.filter(
    (line) =>
      !diagnostics.includes(line) &&
      /(?:^|: )error(?:\[|:)/.test(line) &&
      !(
        diagnostics.length && /^error: could not compile .+ due to \d+ previous errors?/.test(line)
      ),
  );
  if (!diagnostics.length && !globalErrors.length)
    return [
      "cargo check failed. Run: cargo check --manifest-path src-tauri/Cargo.toml --workspace",
      ...lines,
    ];
  return [...diagnostics.filter((line) => isOwnedError(line, files)), ...globalErrors];
}

/** Every per-file check plus the program-wide ones, filtered to `files`. */
export function checkFiles(files) {
  const present = files.filter((file) => existsSync(resolve(ROOT, file)));
  const typescript = present.filter((file) => /\.(ts|tsx)$/.test(file));
  return [
    ...present.flatMap((file) => checkFile(file)),
    ...(typescript.length ? checkTypescript(typescript) : []),
    ...checkLint(present),
    ...checkDependencies(present),
    ...checkRustCompiles(present),
  ];
}

function changedFiles() {
  const base = run("git", ["merge-base", "HEAD", "main"]).stdout.trim();
  const tracked = run("git", ["diff", "--name-only", base]).stdout;
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"]).stdout;
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const named = process.argv.slice(2).map((path) => relative(ROOT, resolve(path)));
  const files = named.length ? named : changedFiles();
  const problems = checkFiles(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ok: ${files.length} changed file(s) pass.`);
}
