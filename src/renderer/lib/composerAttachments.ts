import type { AttachmentMimeType } from "../../shared/types.js";
import { WORKSPACE_DRAG_MIME } from "./gridState.js";

export const SUPPORTED_IMAGE_MIME_TYPES: readonly AttachmentMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
];

export function isSupportedImageMime(mime: string): mime is AttachmentMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

const IMAGE_EXTENSION_MIME: Readonly<Record<string, AttachmentMimeType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};

/** MIME from a filename when the File's own type is empty. Screenshot drops
 *  from the macOS thumbnail often arrive as `Screenshot …png` with no type. */
export function imageMimeFromFileName(name: string): AttachmentMimeType | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] ?? null;
}

/** Minimal drag payload so tests can feed a plain object instead of a live
 *  DataTransfer. Matches the fields the composer actually reads. */
export interface ComposerDragPayload {
  types?: ArrayLike<string> | string | null;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }> | null;
}

/**
 * Formats advertised on a drag. WKWebView sometimes exposes `types` as a
 * comma-separated string rather than an array; Array.from on a string would
 * split it into characters and miss `"Files"`.
 */
export function listDragTypes(dataTransfer: ComposerDragPayload): string[] {
  const types = dataTransfer.types;
  if (types == null) return [];
  if (typeof types === "string") {
    return types
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return Array.from(types);
}

/**
 * Whether the composer should take this drag (highlight + preventDefault so
 * drop can fire). Finder file drags advertise `"Files"`. In-memory images
 * (macOS screenshot thumbnail, Slack, browser) often advertise `image/png`
 * instead, and WKWebView promised-file drags can report no types until drop.
 * Pane rearranges use `WORKSPACE_DRAG_MIME` and must not look like a file drop.
 */
export function isAttachableDrag(dataTransfer: ComposerDragPayload): boolean {
  const types = listDragTypes(dataTransfer);
  if (types.includes(WORKSPACE_DRAG_MIME)) return false;
  if (types.includes("Files")) return true;
  if (types.some((type) => type.startsWith("image/"))) return true;
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") return true;
      if (item.type.startsWith("image/")) return true;
    }
  }
  // Promised files: types and items stay empty through dragover. Taking the
  // drag lets drop fire; collectDroppedFiles then reads the realized files.
  return types.length === 0 && (!items || items.length === 0);
}

function stampItemImageType(file: File, itemType: string): File {
  if (file.type || !isSupportedImageMime(itemType)) return file;
  const stamped = new File([file], file.name || "image", { type: itemType });
  const path = (file as { path?: unknown }).path;
  if (typeof path === "string" && path.length > 0) {
    Object.defineProperty(stamped, "path", { value: path });
  }
  return stamped;
}

/**
 * Files from a drop. WKWebView can leave `files` empty while `items` holds
 * the image (Mail.app images, screenshot thumbnail). When `files` is already
 * populated, that list is the drop: merging `items` on top would attach the
 * same screenshot twice, because wrapping to stamp a MIME creates a new File
 * that no longer matches the original.
 */
export function collectDroppedFiles(dataTransfer: ComposerDragPayload): File[] {
  const fromFiles = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  if (fromFiles.length > 0) return fromFiles;
  if (!dataTransfer.items) return [];
  const out: File[] = [];
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(stampItemImageType(file, item.type));
  }
  return out;
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
