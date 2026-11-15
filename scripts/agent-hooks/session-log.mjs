// Per-session notes for the hooks. Stop checks only the files this session
// edited, so a peer session's work in a shared checkout cannot fail this turn.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sessionFile(sessionId, name) {
  const directory = join(tmpdir(), "argmax-agent-hooks", String(sessionId).replace(/[^\w-]/g, "_"));
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
}

export function editedFilesLog(sessionId) {
  return sessionFile(sessionId, "edited-files");
}

export function readEditedFiles(sessionId) {
  const log = editedFilesLog(sessionId);
  if (!existsSync(log)) return [];
  return [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))];
}

export function clearEditedFiles(sessionId) {
  rmSync(editedFilesLog(sessionId), { force: true });
}

export function seenGuidance(sessionId, text) {
  const log = sessionFile(sessionId, "guidance");
  return existsSync(log) && readFileSync(log, "utf8").split("\n").includes(text);
}

export function rememberGuidance(sessionId, text) {
  appendFileSync(sessionFile(sessionId, "guidance"), `${text}\n`);
}
