#!/usr/bin/env node
// Write the appearance script inlined in index.html and mobile.html, from
// src/renderer/lib/appearanceBootstrap.ts.
//
//   npm run build:appearance-bootstrap
//   node scripts/build-appearance-bootstrap.mjs --check     # no write; exits 1 on drift

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const ENTRIES = [
  { html: "index.html", surface: "desktop" },
  { html: "mobile.html", surface: "mobile" }
];
const REGION = /<!-- appearance-bootstrap:start -->[\s\S]*?<!-- appearance-bootstrap:end -->/;

async function loadScriptBuilder() {
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    server: { middlewareMode: true },
    logLevel: "error"
  });
  try {
    return await server.ssrLoadModule("/src/renderer/lib/appearanceBootstrap.ts");
  } finally {
    await server.close();
  }
}

const { appearanceBootstrapScript } = await loadScriptBuilder();
let stale = false;
for (const { html, surface } of ENTRIES) {
  const file = path.join(repoRoot, html);
  const current = await readFile(file, "utf8");
  if (!REGION.test(current)) {
    console.error(`error: ${html} has no appearance-bootstrap region. Restore the start and end comments.`);
    process.exit(1);
  }
  const body = appearanceBootstrapScript(surface).split("\n").map((line) => `      ${line}`).join("\n");
  const region = `<!-- appearance-bootstrap:start -->\n    <script>\n${body}\n    </script>\n    <!-- appearance-bootstrap:end -->`;
  const next = current.replace(REGION, () => region);
  if (next === current) continue;
  if (check) {
    console.error(`error: ${html} differs from src/renderer/lib/appearanceBootstrap.ts. Run npm run build:appearance-bootstrap.`);
    stale = true;
  } else {
    await writeFile(file, next);
  }
}
process.exit(stale ? 1 : 0);
