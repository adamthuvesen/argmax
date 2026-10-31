#!/usr/bin/env node
// The fast lane: lint, typecheck, and the static gates, in parallel. CI's
// js-static job runs this command verbatim. Not named `check`: npm would
// run the `precheck` script (the pre-push gate) before it.
//
//   npm run check:fast

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CHECKS = [
  ["eslint", ["node_modules/eslint/bin/eslint.js", ".", "--cache", "--cache-strategy", "content", "--cache-location", "node_modules/.cache/eslint/"]],
  ["tsc", ["node_modules/typescript-7/bin/tsc", "--noEmit"]],
  ["static checks", ["scripts/static-checks.mjs"]]
];

const results = await Promise.all(
  CHECKS.map(
    ([label, args]) =>
      new Promise((done) => {
        const started = Date.now();
        const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("close", (status) => {
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          process.stdout.write(`\n${status === 0 ? "✓" : "✗"} ${label} (${seconds}s)\n${status === 0 ? "" : output}`);
          done({ label, status });
        });
      })
  )
);

const failed = results.filter(({ status }) => status !== 0).map(({ label }) => label);
if (failed.length) {
  console.error(`\nerror: ${failed.join(", ")} failed. Fix the errors above, then rerun npm run check:fast.`);
  process.exit(1);
}
