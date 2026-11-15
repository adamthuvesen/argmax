#!/usr/bin/env node
// Type-aware lint plus type check through oxlint, including the project
// `argmax` rules from scripts/oxlint-plugin.mjs. Any diagnostic fails the run.
//
//   npm run lint              check
//   npm run lint -- --fix     apply autofixes first (used by npm run fix)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const targets = args.some((arg) => !arg.startsWith("-")) ? [] : ["."];

const run = spawnSync(
  "node_modules/.bin/oxlint",
  ["--type-aware", "--type-check", "--deny-warnings", ...args, ...targets],
  { cwd: ROOT, stdio: "inherit" },
);
if (run.error) {
  console.error(`error: oxlint could not run.\n${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
