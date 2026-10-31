#!/usr/bin/env node
// Claude Code PreToolUse hook. Refuses the two mistakes an agent cannot undo
// cheaply: hand-editing generated output, and git commands that take a peer's
// work in a checkout several sessions share.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATED = JSON.parse(readFileSync(resolve(ROOT, "scripts/generated-files.json"), "utf8"));

const SHARED_CHECKOUT_COMMANDS = [
  [/\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/, "Stage explicit paths. A blanket add takes a peer session's edits."],
  [/\bgit\s+stash\b/, "Do not stash in a shared checkout. It moves a peer session's edits. Use a detached worktree."],
  [/\bgit\s+(?:checkout\s+--|restore\s+(?!--staged))/, "Do not restore files in a shared checkout. It destroys a peer session's edits."]
];

function refusal(request) {
  const filePath = request.tool_input?.file_path;
  if (filePath) {
    const path = relative(ROOT, resolve(filePath));
    const generated = GENERATED.find(({ pattern }) => new RegExp(pattern).test(path));
    if (generated) return `${path} is generated. Change its source, then run: ${generated.run}`;
  }
  const command = request.tool_input?.command;
  if (typeof command === "string") {
    return SHARED_CHECKOUT_COMMANDS.find(([pattern]) => pattern.test(command))?.[1] ?? null;
  }
  return null;
}

const reason = refusal(JSON.parse(readFileSync(0, "utf8")));
if (reason) {
  console.error(reason);
  process.exit(2);
}
