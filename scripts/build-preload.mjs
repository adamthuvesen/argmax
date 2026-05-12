#!/usr/bin/env node
// Bundles src/main/preload.ts → dist/main/preload.cjs as CommonJS so we can
// run the renderer with `webPreferences.sandbox: true`. Sandboxed preloads
// must be CJS; this project's main is ESM (`"type": "module"`), and tsc
// already emits an ESM preload.js — we run esbuild in addition to tsc so the
// CJS artifact lives next to the rest of the compiled main bundle without
// fighting the ESM toolchain.
import { build } from "esbuild";

const watch = process.argv.includes("--watch");
const isProduction = process.env.NODE_ENV === "production";

const config = {
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/main/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // electron is loaded by the host process, never bundled. Without this,
  // esbuild would try to inline electron's native bindings and fail.
  external: ["electron"],
  sourcemap: !isProduction,
  logLevel: "info"
};

if (watch) {
  const ctx = await (await import("esbuild")).context(config);
  await ctx.watch();
  // Park the process so concurrently keeps the watcher alive.
} else {
  await build(config);
}
