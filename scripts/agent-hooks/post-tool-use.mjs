#!/usr/bin/env node
// After each edit, tells the agent what it must know now: an instant check of
// the edited file, the subsystem rule the first time it touches that subsystem,
// and the generator to run. It never blocks. Stop and precheck do that.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkFile } from "../check-changed.mjs";
import { editedPaths, readHookInput, ROOT } from "./hook-input.mjs";
import { editedFilesLog, seenGuidance, rememberGuidance } from "./session-log.mjs";

const RULES = JSON.parse(readFileSync(resolve(ROOT, "scripts/agent-hooks/feedback-rules.json"), "utf8"));

const request = readHookInput();
const sessionId = request.session_id ?? "unknown";
const messages = [];
for (const path of editedPaths(request)) {
  appendFileSync(editedFilesLog(sessionId), `${path}\n`);
  messages.push(...checkFile(path, { fast: true }));
  const source = existsSync(resolve(ROOT, path)) ? readFileSync(resolve(ROOT, path), "utf8") : "";
  for (const { pattern, paths, text } of RULES.generatedInputs) {
    if (new RegExp(paths).test(path) && new RegExp(pattern).test(source) && !seenGuidance(sessionId, text)) {
      rememberGuidance(sessionId, text);
      messages.push(text);
    }
  }
  for (const { pattern, text } of RULES.guidance) {
    if (new RegExp(pattern).test(path) && !seenGuidance(sessionId, text)) {
      rememberGuidance(sessionId, text);
      messages.push(`${path}: ${text}`);
    }
  }
}

if (messages.length) {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: messages.join("\n") }
  }));
}
