#!/usr/bin/env node
// Type-aware lint plus type check through oxlint. The `argmax` rules that
// have existing violations report as warnings; this script fails when a file
// holds more of them than lint-baseline.json records, so the count only falls.
//
//   npm run lint                    check
//   npm run lint -- --write-baseline   record the current counts
//   npm run lint -- --fix           apply autofixes first (used by npm run fix)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE_PATH = resolve(ROOT, "lint-baseline.json");
const RATCHETED = new Set([
  "argmax(no-container)",
  "argmax(no-node-access)",
  "argmax(no-timeline-payload-access)",
  "argmax(no-raw-model-id)"
]);

const args = process.argv.slice(2);
const writeBaseline = args.includes("--write-baseline");
const oxlintArgs = [
  "--type-aware",
  "--type-check",
  "-f",
  "json",
  ...args.filter((arg) => arg !== "--write-baseline"),
  ...(args.some((arg) => !arg.startsWith("-")) ? [] : ["."])
];

const run = spawnSync("node_modules/.bin/oxlint", oxlintArgs, {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});
if (run.error || !run.stdout.trim().startsWith("{")) {
  console.error(`error: oxlint could not run.\n${run.error?.message ?? (run.stderr || run.stdout)}`);
  process.exit(1);
}
const { diagnostics } = JSON.parse(run.stdout);

const counts = {};
const failures = [];
for (const diagnostic of diagnostics) {
  const { filename, code, message, severity, labels } = diagnostic;
  if (RATCHETED.has(code)) {
    counts[filename] ??= {};
    counts[filename][code] = (counts[filename][code] ?? 0) + 1;
    continue;
  }
  const { line, column } = labels?.[0]?.span ?? {};
  failures.push(`${filename}:${line}:${column}: ${message} [${severity}/${code}]`);
}

if (writeBaseline) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`wrote lint-baseline.json (${Object.keys(sorted).length} files)`);
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
const partial = args.some((arg) => !arg.startsWith("-"));
for (const [filename, rules] of Object.entries(counts)) {
  for (const [code, count] of Object.entries(rules)) {
    const allowed = baseline[filename]?.[code] ?? 0;
    if (count > allowed)
      failures.push(
        `${filename}: ${count} ${code} violations, baseline allows ${allowed}. Fix the new ones; do not raise the baseline.`
      );
  }
}
if (!partial) {
  for (const [filename, rules] of Object.entries(baseline)) {
    for (const [code, allowed] of Object.entries(rules)) {
      const count = counts[filename]?.[code] ?? 0;
      if (count < allowed)
        failures.push(`${filename}: ${code} fell from ${allowed} to ${count}. Run: npm run lint -- --write-baseline`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\nerror: ${failures.length} lint problem${failures.length === 1 ? "" : "s"}.`);
  process.exit(1);
}
