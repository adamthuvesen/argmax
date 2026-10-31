#!/usr/bin/env node
// Claude Code PreToolUse hook. Refuses the two mistakes an agent cannot undo
// cheaply: hand-editing generated output, and git commands that take a peer's
// work in a checkout several sessions share.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { editedPaths, ROOT } from "./hook-input.mjs";

const GENERATED = JSON.parse(readFileSync(resolve(ROOT, "scripts/generated-files.json"), "utf8"));

const STAGE_ALL = "Stage explicit paths. A blanket add takes a peer session's edits.";
const STASH = "Do not stash in a shared checkout. It moves a peer session's edits. Use a detached worktree.";
const RESTORE = "Do not restore files in a shared checkout. It destroys a peer session's edits.";

/** Removes quoted text and heredocs, so a commit message cannot look like a command. */
function shellSegments(command) {
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " QUOTED ")
    .split(/&&|\|\||[;|\n]/);
}

function gitArguments(segment) {
  const words = segment.trim().split(/\s+/);
  const git = words.indexOf("git");
  if (git < 0) return null;
  const rest = words.slice(git + 1);
  while (rest[0]?.startsWith("-")) {
    const option = rest.shift();
    if (option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree") rest.shift();
  }
  return rest;
}

function gitRefusal(args) {
  const [subcommand, ...rest] = args;
  const has = (...options) => rest.some((word) => options.includes(word));
  if (subcommand === "add" && has("-A", "--all", "-u", "--update", ".", ":/")) return STAGE_ALL;
  if (subcommand === "stash" && !["list", "show"].includes(rest[0])) return STASH;
  if (subcommand === "checkout" && has("--", ".")) return RESTORE;
  if (subcommand === "restore" && (has("-W", "--worktree") || !has("-S", "--staged"))) return RESTORE;
  return null;
}

function commandRefusal(command) {
  for (const segment of shellSegments(command)) {
    const args = gitArguments(segment);
    const reason = args && gitRefusal(args);
    if (reason) return reason;
  }
  return null;
}

function refusal(request) {
  for (const path of editedPaths(request)) {
    const generated = GENERATED.find(({ pattern }) => new RegExp(pattern).test(path));
    if (generated) return `${path} is generated. Change its source, then run: ${generated.run}`;
  }
  const command = request.tool_input?.command;
  // Codex passes `apply_patch` text in `command`. That text is file content.
  if (typeof command === "string" && request.tool_name !== "apply_patch") return commandRefusal(command);
  return null;
}

const reason = refusal(JSON.parse(readFileSync(0, "utf8")));
if (reason) {
  console.error(reason);
  process.exit(2);
}
