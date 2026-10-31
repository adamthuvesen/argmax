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
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}

/** Checks fast enough to run after every edit. Returns lines an agent can act on. */
export function checkFile(path, { fast = false } = {}) {
  if (!existsSync(resolve(ROOT, path))) return [];
  const generated = GENERATED.find(({ pattern }) => new RegExp(pattern).test(path));
  if (generated) return [`${path} is generated. Change its source, then run: ${generated.run}`];
  const problems = [];
  if (path.endsWith(".rs") && path.startsWith("src-tauri/")) {
    if (run("rustfmt", ["--check", "--edition", "2021", "--config", "skip_children=true", path]).status === 1) {
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
    if (fonts.status !== 0) problems.push(...outputLines(fonts).filter((line) => line.includes(path) || line.includes("Fix")));
  }
  if (!fast && /\.(ts|tsx)$/.test(path) && path.startsWith("src/")) {
    const related = run("npx", ["--no-install", "vitest", "related", "--run", "--passWithNoTests", "--reporter=dot", path]);
    if (related.status !== 0) {
      problems.push(`${path}: related tests fail. Run: npx vitest related --run ${path}`);
      problems.push(...outputLines(related).filter((line) => /FAIL|AssertionError|Error:/.test(line)).slice(0, 12));
    }
  }
  return problems;
}

function checkTypescript(files) {
  const result = runNode("node_modules/typescript-7/bin/tsc", "--noEmit");
  if (result.status === 0) return [];
  return outputLines(result).filter((line) => files.some((file) => line.startsWith(file)));
}

function checkEslint(files) {
  const lintable = files.filter((file) => /\.(ts|tsx)$/.test(file) && file.startsWith("src/"));
  if (!lintable.length) return [];
  const result = run("npx", ["--no-install", "eslint", "--no-warn-ignored", "--pass-on-unpruned-suppressions", "--format", "json", ...lintable]);
  if (result.status === 0) return [];
  if (result.status !== 1) return [`eslint could not run:`, ...outputLines(result).slice(0, 8)];
  return JSON.parse(result.stdout).flatMap(({ filePath, messages }) =>
    messages.map(({ line, ruleId, message }) => `${relative(ROOT, filePath)}:${line}: ${message} (${ruleId})`)
  );
}

function checkDependencies(files) {
  const sources = files.filter((file) => /^src\/.*\.(ts|tsx)$/.test(file) && existsSync(resolve(ROOT, file)));
  if (!sources.length) return [];
  const result = run("npx", ["--no-install", "depcruise", "--ignore-known", "--output-type", "err-long", ...sources]);
  return result.status === 0 ? [] : outputLines(result).filter((line) => !/^(?:x \d+ dependency violations|‼)/.test(line));
}

/** A file nobody has edited cannot hold a peer's unfinished work, so its errors are this change's. */
function isOwnedError(line, files) {
  const path = `src-tauri/${line.split(":")[0]}`;
  return files.includes(path) || run("git", ["diff", "--quiet", "HEAD", "--", path]).status === 0;
}

function checkRustCompiles(files) {
  if (!files.some((file) => file.endsWith(".rs"))) return [];
  const result = run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml", "--workspace", "--message-format", "short"]);
  if (result.status === 0) return [];
  return outputLines(result).filter((line) => line.includes(": error") && isOwnedError(line, files));
}

/** Every per-file check plus the program-wide ones, filtered to `files`. */
export function checkFiles(files) {
  const present = files.filter((file) => existsSync(resolve(ROOT, file)));
  const typescript = present.filter((file) => /\.(ts|tsx)$/.test(file));
  return [
    ...present.flatMap((file) => checkFile(file)),
    ...(typescript.length ? checkTypescript(typescript) : []),
    ...checkEslint(present),
    ...checkDependencies(present),
    ...checkRustCompiles(present)
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
