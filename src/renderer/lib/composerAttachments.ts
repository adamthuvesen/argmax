import type { AttachmentMimeType } from "../../shared/types.js";

export const SUPPORTED_IMAGE_MIME_TYPES: readonly AttachmentMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
];

export function isSupportedImageMime(mime: string): mime is AttachmentMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Pulls absolute paths off `File` objects (from a drop event or a hidden file
 * input) and formats them as `@path` references that the provider's @-mention
 * parsing can resolve. When the file sits inside the active workspace, the
 * reference is workspace-relative for readability; otherwise it's absolute.
 *
 * `path` is a Tauri-renderer-only field on File. In jsdom tests we set it
 * via `Object.defineProperty(file, "path", { value: "/..." })`.
 */
export function buildAttachmentReferences(
  files: Iterable<File> | Iterable<{ path?: string }>,
  workspacePath: string | null
): string[] {
  const refs: string[] = [];
  for (const file of files) {
    const path = "path" in file ? file.path : undefined;
    if (typeof path !== "string" || path.length === 0) continue;
    refs.push(toReference(path, workspacePath));
  }
  return refs;
}

/** Build a single absolute-path `@reference` string for an image already
 *  persisted under userData. The absolute path bypasses the workspace-relative
 *  shortening that path-on-disk drops use, because attachment files don't live
 *  in the worktree. */
export function imageAttachmentReference(filePath: string): string {
  return `@${filePath}`;
}

/** Reads a Blob to a base64 string (no `data:` prefix). Used by the composer
 *  to ship pasted/dropped image bytes through the `attachments:save-image`
 *  IPC channel. */
export function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read image data."));
        return;
      }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image data."));
    reader.readAsDataURL(blob);
  });
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
