#!/usr/bin/env node
// At the end of a turn, runs the fuller checks on the files this session edited
// in that turn. A failure sends the agent back once. Then the list clears, so a
// problem the agent cannot fix does not cost a turn after every later prompt.

import { checkFiles } from "../check-changed.mjs";
import { readHookInput } from "./hook-input.mjs";
import { clearEditedFiles, readEditedFiles } from "./session-log.mjs";

const request = readHookInput();
const sessionId = request.session_id ?? "unknown";
const files = readEditedFiles(sessionId);
const problems = !request.stop_hook_active && files.length ? checkFiles(files) : [];
if (problems.length) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `Checks failed on files you edited. Fix these before you finish:\n${problems.join("\n")}`,
    }),
  );
} else {
  clearEditedFiles(sessionId);
}
