#!/usr/bin/env node

// Fail the build if the renderer's main entry chunk crosses its size budget.
// The entry chunk is what every cold start downloads before the app paints, so
// an accidental import that pulls a heavyweight dependency into `index-*.js`
// (instead of a lazy/vendor chunk) is the regression this guards against.
// Run after `vite build`; reads the emitted dist tree, never source.

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist/renderer");
const INDEX_HTML = join(DIST, "index.html");

// 2 MiB. Mirrors vite.config.ts `chunkSizeWarningLimit` so a chunk that trips
// Vite's warning also fails CI rather than only printing a notice.
const BUDGET_BYTES = 2 * 1024 * 1024;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(INDEX_HTML, "utf8");
} catch {
  fail(`${INDEX_HTML} not found — run \`npm run build:renderer\` before check:bundle.`);
}

// The entry is the single `<script type="module" ... src="./assets/index-*.js">`
// Vite injects into index.html. Anchoring on the emitted HTML keeps this honest
// across hash and filename changes instead of hard-coding a chunk name.
const match = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
if (!match) {
  fail(`no <script type="module"> entry found in ${INDEX_HTML}.`);
}

const entryHref = match[1].replace(/^\.\//, "");
const entryPath = resolve(DIST, entryHref);

let bytes;
try {
  bytes = statSync(entryPath).size;
} catch {
  fail(`entry chunk ${entryHref} referenced by index.html is missing from ${DIST}.`);
}

const mib = (bytes / 1024 / 1024).toFixed(2);
const budgetMib = (BUDGET_BYTES / 1024 / 1024).toFixed(2);

if (bytes > BUDGET_BYTES) {
  fail(
    `main chunk ${entryHref} is ${mib} MiB (${bytes} bytes), over the ${budgetMib} MiB budget. ` +
      `Move the new weight into a lazy or vendor chunk (see vite.config.ts manualChunks).`
  );
}

console.log(`ok: main chunk ${entryHref} is ${mib} MiB, within the ${budgetMib} MiB budget.`);
