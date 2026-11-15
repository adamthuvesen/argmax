#!/usr/bin/env node
// `npm ci` fails when the root entry of package-lock.json disagrees with package.json.
// Check that locally, so a stale lockfile fails `npm run check` and not only CI.
//
//   node scripts/check-lockfile.mjs

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => JSON.parse(readFileSync(resolve(ROOT, file), "utf8"));
const manifest = read("package.json");
const locked = read("package-lock.json").packages?.[""] ?? {};

const problems = [];
for (const field of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  const wanted = manifest[field] ?? {};
  const have = locked[field] ?? {};
  for (const name of new Set([...Object.keys(wanted), ...Object.keys(have)])) {
    if (wanted[name] !== have[name])
      problems.push(
        `${field}.${name} is "${have[name] ?? "missing"}" in package-lock.json but "${wanted[name] ?? "missing"}" in package.json`,
      );
  }
}
if (problems.length) {
  console.error(
    `error: package-lock.json is stale:\n  ${problems.join("\n  ")}\nFix: run npm install and commit package-lock.json.`,
  );
  process.exit(1);
}
console.log("check-lockfile: package-lock.json matches package.json");
