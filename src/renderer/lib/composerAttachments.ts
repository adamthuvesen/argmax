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

/**
 * Long edge cap for path-less pasted/dropped images. A full retina screenshot
 * is several megabytes of PNG, and its base64 has to survive the provider's
 * single-line JSON stream (4 MiB cap in `providers::normalizer`) — the same
 * reason agent browser screenshots rasterise small. 1920 keeps text readable
 * while bringing a typical screenshot under that budget.
 */
export const MAX_ATTACHMENT_DIMENSION_PX = 1920;

/**
 * Downscales an oversized image so its stored bytes stay comfortably under the
 * provider line cap. Small images pass through untouched, GIFs pass through so
 * animation survives (canvas would flatten to one frame), and anything the
 * runtime cannot decode returns the original — a too-large attach beats a lost
 * paste, and jsdom has no `createImageBitmap` at all.
 */
export async function downscaleImageBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/gif") return blob;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return blob;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (!bitmap.width || !bitmap.height || longest <= MAX_ATTACHMENT_DIMENSION_PX) return blob;
    const scale = MAX_ATTACHMENT_DIMENSION_PX / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const resized = await canvasToBlob(canvas, blob.type);
    if (!resized || resized.size >= blob.size) return blob;
    return resized;
  } catch {
    return blob;
  } finally {
    bitmap?.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob | null> {
  const quality = mimeType === "image/jpeg" ? 0.92 : mimeType === "image/webp" ? 0.9 : undefined;
  return new Promise((resolve) => {
    try {
      canvas.toBlob((result) => resolve(result), mimeType, quality);
    } catch {
      resolve(null);
    }
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
