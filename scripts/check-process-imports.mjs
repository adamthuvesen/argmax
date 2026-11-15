#!/usr/bin/env node
// A JS or TS module that starts a process or opens a socket needs a named owner. Files that already
// do so are listed in scripts/process-imports-baseline.json. A new file fails, and a file that
// stops importing must leave the baseline, so the list can only shrink.
//
//   node scripts/check-process-imports.mjs
//   node scripts/check-process-imports.mjs --update   # after removing an import

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE = "scripts/process-imports-baseline.json";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const BANNED =
  "child_process|net|http|https|http2|tls|dgram|dns|worker_threads|cluster|undici|node-fetch|axios|ws";
const IMPORT = new RegExp(
  `(?:from|import|require\\()\\s*\\(?\\s*["'](?:node:)?(?:${BANNED})(?:/[^"']*)?["']`,
);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: ROOT,
    env,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((name) => SOURCE.test(name));

const found = [];
for (const name of files) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, name), "utf8");
  } catch {
    continue;
  }
  if (text.split("\n").some((line) => IMPORT.test(line))) found.push(name);
}
found.sort();

if (process.argv.includes("--update")) {
  writeFileSync(resolve(ROOT, BASELINE), `${JSON.stringify(found, null, 2)}\n`);
  process.exit(0);
}

const known = JSON.parse(readFileSync(resolve(ROOT, BASELINE), "utf8"));
const added = found.filter((name) => !known.includes(name));
const gone = known.filter((name) => !found.includes(name));
if (added.length || gone.length) {
  if (added.length)
    console.error(
      `error: new process or network import in:\n  ${added.join("\n  ")}\nFix: call an existing owner file instead. A real new owner goes on ${BASELINE} with node scripts/check-process-imports.mjs --update.`,
    );
  if (gone.length)
    console.error(
      `error: no longer imports a process or network module:\n  ${gone.join("\n  ")}\nFix: run node scripts/check-process-imports.mjs --update and commit the result.`,
    );
  process.exit(1);
}
console.log(`check-process-imports: ${known.length} owner files on the baseline, no new ones`);
