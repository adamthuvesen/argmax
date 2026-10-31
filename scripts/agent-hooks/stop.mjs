#!/usr/bin/env node
// At the end of a turn, runs the fuller checks on the files this session edited.
// A failure sends the agent back to fix it. A second stop passes, so a problem
// the agent cannot fix does not trap the session.

import { checkFiles } from "../check-changed.mjs";
import { readHookInput } from "./hook-input.mjs";
import { readEditedFiles } from "./session-log.mjs";

const request = readHookInput();
const files = readEditedFiles(request.session_id ?? "unknown");
if (!request.stop_hook_active && files.length) {
  const problems = checkFiles(files);
  if (problems.length) {
    console.log(JSON.stringify({
      decision: "block",
      reason: `Checks failed on files you edited. Fix these before you finish:\n${problems.join("\n")}`
    }));
  }
}
