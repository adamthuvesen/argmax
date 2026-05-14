#!/usr/bin/env node
/**
 * Renderer bundle-size budget gate (SPEC ralph A5).
 *
 * Reads `dist/renderer/assets/*.js`, identifies the main chunk
 * (`index-*.js`), and exits non-zero if it exceeds the budget.
 *
 * Budget:
 *   - Default: 2.0 MB raw.
 *   - Override via BUNDLE_BUDGET_MB env var (e.g. `BUNDLE_BUDGET_MB=3 npm run check:bundle`).
 *
 * Sums and reports lazy chunks alongside the main chunk so a build that
 * cuts main-chunk weight by lazy-mounting heavy panels shows up as a
 * shift, not a disappearance.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ASSETS_DIR = resolve(
  process.cwd(),
  process.env.BUNDLE_ASSETS_DIR ?? "dist/renderer/assets"
);
const BUDGET_MB = Number.parseFloat(process.env.BUNDLE_BUDGET_MB ?? "2.0");
const BUDGET_BYTES = BUDGET_MB * 1024 * 1024;

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fail(message) {
  process.stderr.write(`check-bundle-size: ${message}\n`);
  process.exit(1);
}

function main() {
  let entries;
  try {
    entries = readdirSync(ASSETS_DIR);
  } catch (error) {
    fail(`could not read ${ASSETS_DIR}: ${error.message}. Run \`npm run build\` first.`);
    return;
  }
  const jsFiles = entries.filter((name) => name.endsWith(".js"));
  if (jsFiles.length === 0) {
    fail(`no .js files found in ${ASSETS_DIR}. Run \`npm run build\` first.`);
    return;
  }

  const mainChunks = jsFiles.filter((name) => name.startsWith("index-"));
  if (mainChunks.length === 0) {
    fail(`no main chunk (index-*.js) found in ${ASSETS_DIR}.`);
    return;
  }

  // If the dir has stale builds (multiple index-*.js), pick the largest —
  // typically the freshest is also the heaviest, and the gate should bite
  // the worst case anyway.
  let mainName = mainChunks[0];
  let mainBytes = statSync(join(ASSETS_DIR, mainName)).size;
  for (const name of mainChunks.slice(1)) {
    const size = statSync(join(ASSETS_DIR, name)).size;
    if (size > mainBytes) {
      mainName = name;
      mainBytes = size;
    }
  }

  const lazyChunks = jsFiles
    .filter((name) => !name.startsWith("index-"))
    .map((name) => ({ name, bytes: statSync(join(ASSETS_DIR, name)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  const lazyTotal = lazyChunks.reduce((sum, c) => sum + c.bytes, 0);

  process.stdout.write(`Renderer bundle:\n`);
  process.stdout.write(`  main (${mainName}): ${formatMB(mainBytes)}\n`);
  for (const chunk of lazyChunks) {
    process.stdout.write(`  lazy (${chunk.name}): ${formatMB(chunk.bytes)}\n`);
  }
  process.stdout.write(`  lazy total: ${formatMB(lazyTotal)}\n`);
  process.stdout.write(`  budget (main): ${BUDGET_MB.toFixed(2)} MB\n`);

  if (mainBytes > BUDGET_BYTES) {
    fail(
      `main chunk ${formatMB(mainBytes)} exceeds ${BUDGET_MB.toFixed(2)} MB budget by ` +
        `${formatMB(mainBytes - BUDGET_BYTES)}. ` +
        `Tighten with a lazy-mount (see SPEC Phase B) or raise BUDGET_MB after Phase B lands.`
    );
    return;
  }
  process.stdout.write(`OK — main chunk under budget by ${formatMB(BUDGET_BYTES - mainBytes)}.\n`);
}

main();
