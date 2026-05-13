/**
 * Pulls absolute paths off `File` objects (from a drop event or a hidden file
 * input) and formats them as `@path` references that the provider's @-mention
 * parsing can resolve. When the file sits inside the active workspace, the
 * reference is workspace-relative for readability; otherwise it's absolute.
 *
 * `path` is an Electron-renderer-only field on File. In jsdom tests we set it
 * via `Object.defineProperty(file, "path", { value: "/..." })`.
 */
export function buildAttachmentReferences(
  files: Iterable<File> | Iterable<{ path?: string }>,
  workspacePath: string | null
): string[] {
  const refs: string[] = [];
  for (const file of files) {
    const path = (file as { path?: string }).path;
    if (typeof path !== "string" || path.length === 0) continue;
    refs.push(toReference(path, workspacePath));
  }
  return refs;
}

function toReference(absolutePath: string, workspacePath: string | null): string {
  if (workspacePath && workspacePath.length > 0) {
    const prefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
    if (absolutePath.startsWith(prefix)) {
      return `@${absolutePath.slice(prefix.length)}`;
    }
  }
  return `@${absolutePath}`;
}

/**
 * Glues attachment references onto the prompt with a single space separator.
 * No-op when there are no references. Used by both the drop handler and the
 * hidden file input change handler so the composer behavior matches across
 * entry paths.
 */
export function appendReferencesToPrompt(prompt: string, references: string[]): string {
  if (references.length === 0) return prompt;
  const joined = references.join(" ");
  if (prompt.length === 0) return joined;
  return `${prompt} ${joined}`;
}
