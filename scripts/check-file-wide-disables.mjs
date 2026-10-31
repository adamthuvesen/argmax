#!/usr/bin/env node
// A file-wide `@ts-nocheck`, `/* oxlint-disable */`, `/* eslint-disable */`, or a Rust inner
// `#![allow(...)]` turns type checking or lint off for the whole file, and no config setting
// overrides it. Disable a
// named rule on one line instead, with a reason.
//
//   node scripts/check-file-wide-disables.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx|rs)$/;
// An inner `#![allow(...)]` silences a lint for a whole Rust crate or module, past the `-D warnings` run.
const RUST_INNER_ALLOW = /^\s*#!\[\s*allow\s*\(/;
// A disable with no rule list is file-wide, with or without a `-- reason` suffix.
const FILE_WIDE =
  /^\s*(?:(?:\/\/|\/\*)\s*@ts-nocheck\b|(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?![-\w])\s*(?:--.*?)?(?:\*\/)?\s*$)/;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const sources = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: ROOT, env, encoding: "utf8" },
)
  .split("\0")
  .filter((name) => SOURCE.test(name));

const hits = [];
for (const name of sources) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, name), "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    if (FILE_WIDE.test(line) || (name.endsWith(".rs") && RUST_INNER_ALLOW.test(line)))
      hits.push(`${name}:${index + 1}`);
  });
}

if (hits.length) {
  console.error(
    `error: file-wide ts-nocheck, lint disable, or Rust #![allow(...)] turns checking off for the whole file:\n  ${hits.join("\n  ")}\nFix: remove it, and disable one named rule on one line (#[allow(...)] in Rust) with a reason.`,
  );
  process.exit(1);
}
console.log(`check-file-wide-disables: ${sources.length} files, none disable checking file-wide`);
