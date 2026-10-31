#!/usr/bin/env node
// The fast lane: type-aware lint with type check, format check, and the
// static gates, in parallel. CI's js-static job runs this command verbatim.
// The pre-push gate is `push-gate`, not `precheck`: npm would run a script
// named `precheck` before `check`.
//
//   npm run check

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (!existsSync(resolve(ROOT, "node_modules/.package-lock.json"))) {
  console.error("error: npm dependencies are missing. Run npm ci, then rerun npm run check.");
  process.exit(1);
}

const CHECKS = [
  ["oxlint + types", ["scripts/lint.mjs"]],
  ["verify helper types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.verify.json"]],
  ["oxfmt", ["node_modules/oxfmt/bin/oxfmt", "--check"]],
  ["static checks", ["scripts/static-checks.mjs"]],
];

const results = await Promise.all(
  CHECKS.map(
    ([label, args]) =>
      new Promise((done) => {
        const started = Date.now();
        const child = spawn(process.execPath, args, {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("close", (status) => {
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          process.stdout.write(
            `\n${status === 0 ? "✓" : "✗"} ${label} (${seconds}s)\n${status === 0 ? "" : output}`,
          );
          done({ label, status });
        });
      }),
  ),
);

const failed = results.filter(({ status }) => status !== 0).map(({ label }) => label);
if (failed.length) {
  console.error(
    `\nerror: ${failed.join(", ")} failed. Fix the errors above, then rerun npm run check.`,
  );
  process.exit(1);
}
