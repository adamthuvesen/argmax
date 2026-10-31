#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const problems = [];
const catalogue = readFileSync("src-tauri/src/ipc/catalogue.rs", "utf8");
const entries = [
  ...catalogue.matchAll(/"([^"]+)"\s*=>\s*(\w+)::(\w+),\s*(desktop|read|control),/g),
];
const registrations = new Map();
for (const file of readdirSync("src-tauri/src/ipc").filter((name) => name.endsWith(".rs"))) {
  const source = readFileSync(join("src-tauri/src/ipc", file), "utf8");
  for (const match of source.matchAll(
    /#\[tauri::command\(rename = "([^"]+)"[^\]]*\)\]([\s\S]*?)pub (?:async )?fn (\w+)\(/g,
  )) {
    registrations.set(match[1], `${basename(file, ".rs")}::${match[3]}`);
  }
}
const seen = new Set();
for (const [, channel, module, method] of entries) {
  if (seen.has(channel)) problems.push(`duplicate catalogue channel: ${channel}`);
  seen.add(channel);
  if (registrations.get(channel) !== `${module}::${method}`) {
    problems.push(
      `${channel}: catalogue handler differs from the Tauri command. Fix the entry in src-tauri/src/ipc/catalogue.rs.`,
    );
  }
}
for (const channel of registrations.keys()) {
  if (!seen.has(channel))
    problems.push(`missing catalogue entry: ${channel}. Add it to src-tauri/src/ipc/catalogue.rs.`);
}

const app = readFileSync("src/renderer/App.tsx", "utf8");
if (/api\.(?:workspaces\.openInIde|projects\.(?:pickFolder|remove))\(/.test(app)) {
  problems.push("App.tsx: catalog mutations belong in workspace/project action hooks");
}
for (const file of [
  "src-tauri/src/routines/scheduler.rs",
  "src-tauri/src/workspaces/orchestration.rs",
  "src-tauri/src/application/session_launch.rs",
]) {
  const source = readFileSync(file, "utf8");
  if (/crate::ipc|\bipc::\{|crate::state::AppState|tauri::/.test(source)) {
    problems.push(`${file}: application behavior depends on a transport or shell`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: ${entries.length} command registrations and application dependency boundaries`);
