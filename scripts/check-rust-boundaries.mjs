#!/usr/bin/env node
// Layer rules the compiler cannot state. The compiler already rejects an import
// from argmax-store or argmax-contracts into the app crate. These rules cover
// what stays inside one crate. Existing violations live in
// scripts/rust-boundaries-baseline.json: a new one fails, and a fixed one must
// be removed from the baseline, so the count can only fall.
//
//   npm run check:rust-boundaries
//   node scripts/check-rust-boundaries.mjs --update   # after removing violations

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP_ROOT = "src-tauri/src";
const CRATES_ROOT = "src-tauri/crates";
const BASELINE_PATH = "scripts/rust-boundaries-baseline.json";

const APP_ONLY = (path) => !path.startsWith("crates/");

const RULES = [
  {
    id: "sql-outside-store",
    // SQL text, or a rusqlite call that runs it. Naming a Connection or a
    // Transaction to pass it through to the store does not count.
    pattern:
      /"\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|PRAGMA|CREATE|DROP|ALTER|VACUUM|WITH)\s|\.(?:prepare|prepare_cached|execute_batch|query_row|pragma_update|pragma_query_value)\(/g,
    allowed: (path) => !APP_ONLY(path),
    fix: "Add a query function in src-tauri/crates/argmax-store/src/ and call it from here.",
  },
  {
    id: "git-outside-exec",
    pattern: /Command::new\(\s*"git"\s*\)/g,
    allowed: (path) => path.startsWith("git/") || path.startsWith("crates/argmax-process/"),
    fix: "Run git through src-tauri/crates/argmax-process/src/git_exec.rs, which sets GIT_LITERAL_PATHSPECS and the environment.",
  },
  {
    id: "process-outside-owner",
    skipComments: true,
    pattern: /\bCommand::new\(|\bstd::process::Command\b|\btokio::process\b/g,
    allowed: (path) => path.startsWith("crates/argmax-process/"),
    fix: "Start processes through src-tauri/crates/argmax-process. A new call site needs an owner there, not a new Command::new.",
  },
  {
    id: "network-outside-owner",
    skipComments: true,
    pattern:
      /\b(?:TcpStream|TcpListener|UdpSocket|UnixStream|UnixListener)\b|\breqwest::|\bhyper::|\bureq::|\btokio::net\b/g,
    allowed: (path) => path.startsWith("crates/argmax-process/"),
    fix: "Open sockets and HTTP clients in src-tauri/crates/argmax-process, or in an owner file already on scripts/rust-boundaries-baseline.json. Do not open them in a new module.",
  },
  {
    id: "turn-end-outside-owner",
    pattern: /SessionStateInput::transition\(\s*SessionState::(?:Complete|Failed|Cancelled)\b/g,
    allowed: (path) => path === "providers/session_service_turn_end.rs",
    fix: "End a turn through commit_turn_end in src-tauri/src/providers/session_service_turn_end.rs.",
  },
  {
    id: "lower-layer-imports-ipc",
    pattern: /crate::ipc\b|^\s+ipc::/gm,
    // The remote bridge is a second transport over the same catalogue.
    allowed: (path) =>
      !APP_ONLY(path) || path.startsWith("ipc/") || path.startsWith("remote/") || path === "lib.rs",
    fix: "ipc is the transport edge. Move the shared type or function out of ipc so both sides import it from below.",
  },
  {
    id: "person-attestation-outside-ipc",
    pattern: /\bminted_by_ipc\s*\(|\battest_person\s*\(/g,
    allowed: (path) => path.startsWith("ipc/") || path === "crates/argmax-store/src/authorship.rs",
    fix: "Only the person IPC handlers mint a PersonAttestation. A chat reference is a read grant only when a person wrote it.",
  },
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
  if (/(^|[_/])tests?(\.rs|\/)/.test(path) || /(^|\/)test_support\.rs$/.test(path)) return "";
  const testModule = source.search(/^#\[cfg\(test\)\]\s*\n\s*(?:pub(?:\(crate\))?\s+)?mod\s/m);
  return testModule < 0 ? source : source.slice(0, testModule);
}

const sources = [
  ...rustFiles(APP_ROOT).map((file) => [relative(APP_ROOT, file), file]),
  ...rustFiles(CRATES_ROOT).map((file) => [join("crates", relative(CRATES_ROOT, file)), file]),
];

const found = Object.fromEntries(RULES.map((rule) => [rule.id, {}]));
for (const [path, file] of sources) {
  const source = productionSource(path, readFileSync(file, "utf8"));
  for (const rule of RULES) {
    if (rule.allowed(path)) continue;
    const text = rule.skipComments ? source.replace(/^\s*\/\/.*$/gm, "") : source;
    const count = text.match(rule.pattern)?.length ?? 0;
    if (count) found[rule.id][path] = count;
  }
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(
    Object.entries(found).map(([id, files]) => [
      id,
      Object.fromEntries(Object.entries(files).sort()),
    ]),
  );
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const problems = [];
const display = (path) =>
  path.startsWith("crates/") ? `src-tauri/${path}` : `${APP_ROOT}/${path}`;
for (const rule of RULES) {
  const known = baseline[rule.id] ?? {};
  for (const [path, count] of Object.entries(found[rule.id])) {
    if (count > (known[path] ?? 0)) {
      problems.push(
        `${display(path)}: ${rule.id}, ${count} use(s), ${known[path] ?? 0} allowed. ${rule.fix}`,
      );
    }
  }
  for (const [path, count] of Object.entries(known)) {
    if ((found[rule.id][path] ?? 0) < count) {
      problems.push(
        `${display(path)}: ${rule.id} fell below the baseline. Run node scripts/check-rust-boundaries.mjs --update and commit the result.`,
      );
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const remaining = RULES.map((rule) => `${rule.id} ${Object.keys(found[rule.id]).length}`).join(
  ", ",
);
console.log(`ok: Rust boundaries. Files on the baseline: ${remaining}.`);
