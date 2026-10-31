#!/usr/bin/env node
// Layer rules for src-tauri/src. Existing violations live in
// scripts/rust-boundaries-baseline.json: a new one fails, and a fixed one must
// be removed from the baseline, so the count can only fall.
//
//   npm run check:rust-boundaries
//   node scripts/check-rust-boundaries.mjs --update   # after removing violations

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = "src-tauri/src";
const BASELINE_PATH = "scripts/rust-boundaries-baseline.json";

const RULES = [
  {
    id: "sql-outside-persistence",
    pattern: /\brusqlite\b/g,
    allowed: (path) => path.startsWith("persistence/"),
    fix: "Add a query function in src-tauri/src/persistence/ and call it from here."
  },
  {
    id: "git-outside-exec",
    pattern: /Command::new\(\s*"git"\s*\)/g,
    allowed: (path) => path.startsWith("git/"),
    fix: "Run git through src-tauri/src/git/exec.rs, which sets GIT_LITERAL_PATHSPECS and the environment."
  },
  {
    id: "persistence-imports-upward",
    pattern: /crate::(?:ipc|providers|sessions|workspaces|gh)\b/g,
    allowed: (path) => !path.startsWith("persistence/"),
    fix: "persistence is the bottom layer. Move the shared type down into persistence or a contract module."
  },
  {
    id: "lower-layer-imports-ipc",
    pattern: /crate::ipc\b/g,
    allowed: (path) => path.startsWith("ipc/") || path.startsWith("persistence/") || path === "lib.rs",
    fix: "ipc is the transport edge. Move the shared type out of ipc so both sides import it from below."
  }
];

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.name.endsWith(".rs") ? [path] : [];
  });
}

// Test code may reach across layers to build fixtures.
function productionSource(path, source) {
  if (/(^|[_/])tests?(\.rs|\/)/.test(path)) return "";
  const testModule = source.search(/^#\[cfg\(test\)\]\s*\n\s*(?:pub(?:\(crate\))?\s+)?mod\s/m);
  return testModule < 0 ? source : source.slice(0, testModule);
}

const found = Object.fromEntries(RULES.map((rule) => [rule.id, {}]));
for (const file of rustFiles(SOURCE_ROOT)) {
  const path = relative(SOURCE_ROOT, file);
  const source = productionSource(path, readFileSync(file, "utf8"));
  for (const rule of RULES) {
    if (rule.allowed(path)) continue;
    const count = source.match(rule.pattern)?.length ?? 0;
    if (count) found[rule.id][path] = count;
  }
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(
    Object.entries(found).map(([id, files]) => [id, Object.fromEntries(Object.entries(files).sort())])
  );
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const problems = [];
for (const rule of RULES) {
  const known = baseline[rule.id] ?? {};
  for (const [path, count] of Object.entries(found[rule.id])) {
    if (count > (known[path] ?? 0)) {
      problems.push(`${SOURCE_ROOT}/${path}: ${rule.id}, ${count} use(s), ${known[path] ?? 0} allowed. ${rule.fix}`);
    }
  }
  for (const [path, count] of Object.entries(known)) {
    if ((found[rule.id][path] ?? 0) < count) {
      problems.push(`${SOURCE_ROOT}/${path}: ${rule.id} fell below the baseline. Run node scripts/check-rust-boundaries.mjs --update and commit the result.`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const remaining = RULES.map((rule) => `${rule.id} ${Object.keys(found[rule.id]).length}`).join(", ");
console.log(`ok: Rust boundaries. Files on the baseline: ${remaining}.`);
