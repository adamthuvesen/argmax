#!/usr/bin/env node

// Tauri resolves a synchronous `#[tauri::command]` body inline on the macOS
// main thread, so anything it blocks on — a SQLite read, a git shellout, a file
// write, a PTY — freezes the whole window rather than just that channel.
//
// The `async` flag is not a fix for blocking work: it is `tokio::spawn`, which
// parks a worker that provider IO, the remote bridge, and the `dashboard:delta`
// emit loop all share. Work that genuinely blocks belongs in `spawn_blocking`
// (see `read_off_main` in src-tauri/src/ipc/mod.rs).
//
// Rather than guess which bodies block, this enforces the reviewable version of
// the rule: every synchronous handler is named here with a reason. Adding one
// is a deliberate act, not an accident.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const IPC_DIR = join(process.cwd(), "src-tauri/src/ipc");

/** Channels allowed to resolve on the main thread, and why. */
const MAIN_THREAD_ALLOWLIST = new Map([
  ["health:ping", "returns a constant; no IO"],
  ["system:set-theme", "sets window appearance, which must happen on the main thread"],
  ["system:open-path", "hands the path to the system opener"],
  ["system:diagnostics", "small fixed-size reads for the Settings pane"],
  ["system:debug-snapshot", "reads two in-memory ring buffers; no IO"],
  ["browser:open", "manipulates the native child webview"],
  ["browser:navigate", "manipulates the native child webview"],
  ["browser:back", "manipulates the native child webview"],
  ["browser:forward", "manipulates the native child webview"],
  ["browser:reload", "manipulates the native child webview"],
  ["browser:stop", "manipulates the native child webview"],
  ["browser:set-bounds", "manipulates the native child webview"],
  ["browser:close", "manipulates the native child webview"],
  ["attachments:save-image", "one small write to the app-owned attachment store"],
  ["approvals:resolve", "single-row write on a small table"],
  ["approvals:pending", "single-row read on a small table"],
  ["providers:resize", "in-memory PTY size update"],
  ["providers:cancel-queued-message", "in-memory queue edit"],
  ["terminal:resize", "in-memory PTY size update"],
  ["prs:list-for-session", "indexed read of one session's PR rows"],
  ["session:cost-summary", "indexed aggregate over one session"],
  ["skills:list", "small read plus a cached registry lookup"],
  ["learnings:update", "single-row write"],
  ["learnings:delete", "single-row write"],
  ["projects:update-settings", "single-row write"],
  ["routines:list", "small table, bounded by the number of scheduled tasks"],
  ["routines:delete", "single-row write"],
  ["routines:set-enabled", "single-row write"],
  ["workspaces:create-current", "single-row write plus a delta publish"],
  ["workspaces:keep", "single-row write"],
  ["workspaces:set-pinned", "single-row write"],
  ["workspaces:set-priority-added", "single-row write"],
  ["workspaces:set-priority-dismissed", "single-row write"],
  ["workspaces:set-label", "single-row write"],
  ["workspaces:set-icon", "single-row write"]
]);

const files = readdirSync(IPC_DIR).filter((name) => name.endsWith(".rs"));
const synchronous = [];
const asynchronous = new Set();

for (const file of files) {
  const source = readFileSync(join(IPC_DIR, file), "utf8");
  // `#[tauri::command(...)]`, optional `#[specta::specta]`, then the fn.
  const pattern = /#\[tauri::command(\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*pub\s+(async\s+)?fn\s+(\w+)/g;
  for (const match of source.matchAll(pattern)) {
    const [, args = "", isAsyncFn, fnName] = match;
    const renamed = /rename\s*=\s*"([^"]+)"/.exec(args);
    const channel = renamed ? renamed[1] : fnName;
    const hasAsyncFlag = /\basync\b/.test(args.replace(/rename\s*=\s*"[^"]*"/, ""));
    if (isAsyncFn || hasAsyncFlag) {
      asynchronous.add(channel);
    } else {
      synchronous.push({ channel, file });
    }
  }
}

const unlisted = synchronous.filter(({ channel }) => !MAIN_THREAD_ALLOWLIST.has(channel));
const stale = [...MAIN_THREAD_ALLOWLIST.keys()].filter(
  (channel) => asynchronous.has(channel) || !synchronous.some((entry) => entry.channel === channel)
);

let failed = false;

if (unlisted.length > 0) {
  failed = true;
  console.error(
    `\n${unlisted.length} synchronous #[tauri::command] handler(s) resolve on the macOS main thread and are not accounted for:\n`
  );
  for (const { channel, file } of unlisted) {
    console.error(`  ${channel}  (src-tauri/src/ipc/${file})`);
  }
  console.error(
    "\nIf it touches SQLite, git, the filesystem, or a PTY, make it `pub async fn` and run the body\n" +
      "through `read_off_main` / `spawn_blocking`. The `async` flag alone is not enough — it parks a\n" +
      "shared tokio worker. If it genuinely belongs on the main thread, add it to\n" +
      "MAIN_THREAD_ALLOWLIST in scripts/check-main-thread-handlers.mjs with a reason.\n"
  );
}

if (stale.length > 0) {
  failed = true;
  console.error(
    `\n${stale.length} MAIN_THREAD_ALLOWLIST entr(y/ies) no longer name a synchronous handler — remove them:\n`
  );
  for (const channel of stale) {
    console.error(`  ${channel}`);
  }
  console.error("");
}

if (failed) {
  process.exit(1);
}

console.log(
  `ok: ${asynchronous.size} handlers resolve off the main thread; ${synchronous.length} are allowlisted.`
);
