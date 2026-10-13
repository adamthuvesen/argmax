#!/usr/bin/env node
// Docs integrity: local links resolve, every docs/*.md is reachable from
// the AGENTS.md index (directly or through an index page), docs/plan and
// docs/design snapshots are listed by their index, and measurements that
// drift silently (the MCP tool count) match the code that owns them.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const fail = (msg) => failures.push(msg);

function mdFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const docs = [
  ...mdFiles(join(ROOT, "docs")),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "README.md"),
  join(ROOT, "GLOSSARY.md"),
].filter(existsSync);

// 1. Local markdown links resolve.
const linkRe = /\]\(([^)#\s]+)(#[^)]*)?\)/g;
for (const file of docs) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkRe)) {
    const target = match[1];
    if (/^(https?:|mailto:|argmax:)/.test(target)) continue;
    // Placeholder examples in prose, not links to files.
    if (target === "path" || target.includes("<")) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      fail(`${file.slice(ROOT.length + 1)}: malformed link target ${target}`);
      continue;
    }
    const resolved = resolve(dirname(file), decoded);
    if (!existsSync(resolved)) {
      fail(`${file.slice(ROOT.length + 1)}: broken link ${target}`);
    }
  }
}

// 2. Reachability: every docs/*.md top-level file is named in AGENTS.md,
//    and every plan/design entry is listed by its index page.
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
for (const entry of readdirSync(join(ROOT, "docs"))) {
  if (entry.endsWith(".md") && !agents.includes(`docs/${entry}`)) {
    fail(`docs/${entry} is not referenced from AGENTS.md`);
  }
}
for (const group of ["plan", "design"]) {
  const indexPath = join(ROOT, "docs", group, "README.md");
  if (!existsSync(indexPath)) {
    fail(`docs/${group}/README.md index is missing`);
    continue;
  }
  const index = readFileSync(indexPath, "utf8");
  for (const entry of readdirSync(join(ROOT, "docs", group))) {
    const full = join(ROOT, "docs", group, entry);
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      isDirectory = false;
    }
    const isEntry =
      (entry.endsWith(".md") && entry !== "README.md") ||
      (isDirectory && existsSync(join(full, "index.html")));
    if (isEntry && !index.includes(entry.replace(/\.md$/, ""))) {
      fail(`docs/${group}/${entry} is not listed in docs/${group}/README.md`);
    }
  }
}

// 3. The MCP tool count stated in docs matches the registered tools.
function toolCount(rel) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  return (text.match(/#\[tool\(/g) || []).length;
}
const total =
  toolCount("src-tauri/src/mcp/browser_tools.rs") +
  toolCount("src-tauri/src/mcp/session_tools.rs") +
  toolCount("src-tauri/src/mcp/visualization_tools.rs");
const browser = toolCount("src-tauri/src/mcp/browser_tools.rs");
for (const rel of ["docs/agent-tools.md", "docs/browser.md"]) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const match of text.matchAll(/(\d+) of the (?:server's )?(\d+)|(\d+) tools and/g)) {
    const stated = match[2] ?? match[3];
    if (Number(stated) !== total) {
      fail(`${rel}: states ${stated} MCP tools, code registers ${total}`);
    }
    if (match[1] && Number(match[1]) !== browser) {
      fail(`${rel}: states ${match[1]} browser tools, code registers ${browser}`);
    }
  }
}

if (failures.length) {
  console.error(`check-docs: ${failures.length} problem(s)`);
  for (const problem of failures) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `check-docs: ${docs.length} files, links ok, index ok, MCP tools ${total} (browser ${browser})`
);
