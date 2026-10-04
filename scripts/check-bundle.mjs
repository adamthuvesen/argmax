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

// Allow modest headroom above the September 2026 graph (1.70 / 1.58 MiB).
// Desktop is 1.81 after the chat timeline, the multitask card, and the Router
// and translucency styles joined the first-paint stylesheet. Measured
// 2026-09-28 at 1.79 MiB. Mobile is tighter: it ships over the tailnet to a
// phone, not off local disk.
// Mobile is 1.62 after chat file chips learned anchored paths with spaces,
// long extensions, and an existence check (+1.2 KB). Measured 2026-10-03 at
// 1,689,334 bytes; the 1.61 budget had 76 bytes left.
// Desktop is 1.83 after the composers' chat references, background send, usage
// chip and window-capture receiver (+14.2 KB eager: 1,891,115 to 1,905,285
// bytes, lane B alone on b0a921ce). With the runtime, workspace and capture
// lanes integrated the desktop entry measures 1,911,148 bytes (2026-10-04),
// over 1.82 MiB (1,908,408) and 7.7 KB under 1.83 MiB (1,918,894). The prompt
// editor itself, CodeMirror and its commands, is hundreds of kilobytes of
// script and stays out of the eager graph: ComposerEditor.tsx loads it as its
// own chunk and shows a textarea until then.
// Desktop is 1.84 after new chats learned to start in an existing worktree
// (1,918,933 bytes, 39 over 1.83 MiB) and OpenCode's catalog moved to
// `openrouter/<vendor>/<model>` ids (+148 bytes, 1,919,081, 2026-10-04).
const ENTRIES = [
  { html: "index.html", label: "desktop", budgetBytes: 1.84 * 1024 * 1024 },
  { html: "mobile.html", label: "mobile", budgetBytes: 1.62 * 1024 * 1024 }
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
