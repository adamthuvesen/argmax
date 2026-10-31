#!/usr/bin/env node
// Docs integrity: local links resolve, every docs/*.md is reachable from
// the AGENTS.md index (directly or through an index page), docs/plan and
// docs/design snapshots are listed by their index, and measurements that
// drift silently (the MCP tool count) match the code that owns them, and
// every enforcer the Enforced Rules table cites exists.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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
      fail(
        `${rel}: states ${stated} MCP tools, code registers ${total}. Update the number in ${rel}.`,
      );
    }
    if (match[1] && Number(match[1]) !== browser) {
      fail(
        `${rel}: states ${match[1]} browser tools, code registers ${browser}. Update the number in ${rel}.`,
      );
    }
  }
}

// 4. Every row of the AGENTS.md "Enforced by" column cites something real. A
//    path must be a tracked file, `path::name` must name a word in that file,
//    and an npm script must be defined. Any other name must be a word in the
//    files the row cites (paths, and the scripts its npm scripts run), or in
//    code (not docs) when the row cites no file. A row that cites nothing fails.
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
const npmScripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const rulesTable = agents.split("\n## Enforced Rules\n")[1]?.split("\n## ")[0] ?? "";
const rows = rulesTable.split("\n").filter((line) => /^\| (?!Rule |---)/.test(line));
if (!rows.length)
  fail(
    "AGENTS.md has no ## Enforced Rules table. Restore the section and its | Rule | Enforced by | rows.",
  );
const tableLines = (agents.split("\n## Enforced Rules\n")[1] ?? "")
  .split("\n")
  .filter((line) => line.trim() !== "");
const tableStart = tableLines.findIndex((line) => line.startsWith("|"));
if (!/^\|\s*Rule\s*\|\s*Enforced by\s*\|/.test(tableLines[tableStart] ?? ""))
  fail("AGENTS.md Enforced Rules table header must start with | Rule | Enforced by |.");
if (tableLines.slice(Math.max(tableStart, 0)).some((line) => !line.startsWith("|")))
  fail(
    "AGENTS.md Enforced Rules must be the last section, with only table rows after its header. Move prose above the table.",
  );
const filesFor = (path) =>
  tracked.filter(
    (file) =>
      file === path || file.endsWith(`/${path}`) || (path.endsWith("/") && file.startsWith(path)),
  );
const hasWord = (name, paths) =>
  spawnSync("git", ["grep", "-qwF", "--", name, ...paths], { cwd: ROOT }).status === 0;
const CODE = [":!*.md", ":!docs/"];
for (const row of rows) {
  const cited = [...row.split("|")[2].matchAll(/`([^`]+)`/g)].map(([, raw]) => {
    const name = raw.replace(/^(npm run|cargo test) /, "").replace(/( --check|\(\))$/, "");
    const [file, key] = name.split("::");
    const kind =
      key && (/\.\w+$/.test(file) || tracked.includes(file))
        ? "key"
        : /^\.|\/$|\.(mjs|cjs|js|ts|tsx|rs|swift|json|txt|toml)$/.test(name)
          ? "path"
          : name in npmScripts
            ? "script"
            : "name";
    return { raw, name, kind, file, key };
  });
  if (!cited.length)
    fail(
      `AGENTS.md Enforced Rules row cites no enforcer: ${row.split("|")[1].trim()}. Cite a file, path::name, or npm script in backticks.`,
    );
  const enforcers = cited.flatMap(({ kind, name, file }) =>
    kind === "path"
      ? filesFor(name)
      : kind === "key"
        ? filesFor(file)
        : kind === "script"
          ? (npmScripts[name].match(/scripts\/[\w./-]+\.m?js/g) ?? [])
          : [],
  );
  for (const { raw, name, kind, file, key } of cited) {
    const problem =
      kind === "path"
        ? filesFor(name).length
          ? null
          : "is not a tracked file"
        : kind === "key"
          ? filesFor(file).length && hasWord(key, filesFor(file))
            ? null
            : `needs ${file} to be tracked and to define ${key}`
          : kind === "script"
            ? null
            : hasWord(name, enforcers.length ? enforcers : CODE)
              ? null
              : `does not appear in ${enforcers.length ? `the cited enforcer (${[...new Set(enforcers)].join(", ")})` : "code outside docs"}`;
    if (problem)
      fail(
        `AGENTS.md Enforced Rules cites \`${raw}\`, which ${problem}. Fix the citation or the enforcer.`,
      );
  }
}

if (failures.length) {
  console.error(`check-docs: ${failures.length} problem(s)`);
  for (const problem of failures) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `check-docs: ${docs.length} files, links ok, index ok, MCP tools ${total} (browser ${browser})`,
);
