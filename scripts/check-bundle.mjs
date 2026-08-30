#!/usr/bin/env node

// Fail the build if a renderer entry's eager module graph crosses its size
// budget. The eager graph is what a cold start downloads before the app paints:
// the `<script type="module">` entry plus every `<link rel="modulepreload">`
// Vite emits alongside it. Statting only the entry chunk is not enough — with
// two entries (desktop + mobile) rolldown hoists shared app code into a chunk
// both HTML files preload, so a heavyweight import can land entirely outside
// `index-*.js` and still be on the critical path.
//
// Scope: JS only. The render-blocking stylesheet is budgeted separately (it
// tracks the design tokens, not dependency weight), and the regression this
// guards against — an accidental import pulling a heavy dependency out of a
// lazy chunk and into the preload set — is a JS-graph regression.
//
// Run after `vite build`; reads the emitted dist tree, never source.

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist/renderer");

// Budgets sit roughly a third above the measured graph, so ordinary growth
// passes and a newly-eager dependency fails. Mobile ought to be the tighter of
// the two — it ships over the tailnet to a phone, not off the local disk — but
// it still pulls the review screen's tree eagerly, so its budget holds today's
// measurement to stop further growth and drops to ~1 MiB once that screen
// loads lazily.
const ENTRIES = [
  { html: "index.html", label: "desktop", budgetBytes: 1.25 * 1024 * 1024 },
  { html: "mobile.html", label: "mobile", budgetBytes: 2.25 * 1024 * 1024 }
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

// Anchoring on the emitted HTML keeps this honest across hash and filename
// changes instead of hard-coding chunk names.
const ENTRY_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g;
const MODULE_PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g;

for (const entry of ENTRIES) {
  const htmlPath = join(DIST, entry.html);
  let html;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    fail(`${htmlPath} not found — run \`npm run build:renderer\` before check:bundle.`);
  }

  const hrefs = [
    ...[...html.matchAll(ENTRY_SCRIPT)].map((match) => match[1]),
    ...[...html.matchAll(MODULE_PRELOAD)].map((match) => match[1])
  ];
  if (hrefs.length === 0) {
    fail(`no <script type="module"> entry found in ${htmlPath}.`);
  }

  let total = 0;
  let largest = { href: hrefs[0], bytes: 0 };
  for (const href of hrefs) {
    const chunkHref = href.replace(/^\.\//, "");
    let bytes;
    try {
      bytes = statSync(resolve(DIST, chunkHref)).size;
    } catch {
      fail(`chunk ${chunkHref} referenced by ${entry.html} is missing from ${DIST}.`);
    }
    total += bytes;
    if (bytes > largest.bytes) largest = { href: chunkHref, bytes };
  }

  if (total > entry.budgetBytes) {
    fail(
      `${entry.label} entry (${entry.html}) loads ${mib(total)} MiB (${total} bytes) across ` +
        `${hrefs.length} eager chunks, over the ${mib(entry.budgetBytes)} MiB budget. ` +
        `Largest: ${largest.href} at ${mib(largest.bytes)} MiB. ` +
        `Move the new weight behind a lazy import (see SessionPane.tsx) or a vendor chunk ` +
        `(see vite.config.ts manualChunks).`
    );
  }

  console.log(
    `ok: ${entry.label} entry (${entry.html}) loads ${mib(total)} MiB across ${hrefs.length} eager ` +
      `chunks, within the ${mib(entry.budgetBytes)} MiB budget.`
  );
}
