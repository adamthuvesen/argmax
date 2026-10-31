#!/usr/bin/env node
// Every sub-second-to-seconds gate, in one list. `push-gate` and CI both run
// this file, so a check cannot exist in one place and not the other.
//
//   npm run check:static

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CHECKS = [
  ["IPC channel parity", "scripts/check-tauri-bridge.mjs"],
  ["docs integrity", "scripts/check-docs.mjs"],
  ["architecture boundaries", "scripts/check-architecture.mjs"],
  ["dead code", "node_modules/knip/bin/knip.js", "--no-progress"],
  ["Rust boundaries", "scripts/check-rust-boundaries.mjs"],
  [
    "renderer boundaries",
    "--import",
    "./scripts/typescript-5-hook.mjs",
    "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
    "--ignore-known",
    "--output-type",
    "err-long",
    "src",
  ],
  ["remote contracts", "scripts/export-remote-contracts.mjs", "--check"],
  ["Swift contracts", "scripts/export-swift-contracts.mjs", "--check"],
  ["main-thread handler allowlist", "scripts/check-main-thread-handlers.mjs"],
  ["iOS typography", "scripts/check-ios-fonts.mjs"],
  ["iOS model catalogue", "scripts/export-provider-models.mjs", "--check"],
  ["visualization runtime", "scripts/build-visualization-runtime.mjs", "--check"],
  ["appearance bootstrap", "scripts/build-appearance-bootstrap.mjs", "--check"],
];

for (const [label, ...args] of CHECKS) {
  const run = spawnSync("node", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (run.status !== 0) {
    console.error(`\nerror: ${label} failed (node ${args.join(" ")})`);
    process.exit(run.status ?? 1);
  }
}
