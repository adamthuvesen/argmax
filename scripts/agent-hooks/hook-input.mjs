// What Claude Code and Codex pass a hook, reduced to repository paths.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function readHookInput() {
  return JSON.parse(readFileSync(0, "utf8"));
}

/** Codex `apply_patch` names files in the patch text. Claude Code has `file_path`. */
export function editedPaths(request) {
  const input = request.tool_input ?? {};
  const absolute = input.file_path ? [input.file_path] : [];
  const patch = typeof input.command === "string" ? input.command : (input.patch ?? input.input ?? "");
  const patched =
    request.tool_name === "apply_patch" || typeof input.patch === "string"
      ? [...String(patch).matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) => match[1].trim())
      : [];
  return [...absolute, ...patched]
    .map((path) => relative(ROOT, isAbsolute(path) ? path : resolve(request.cwd ?? ROOT, path)))
    .filter((path) => !path.startsWith(".."));
}
