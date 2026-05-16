import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { errorMessage } from "../../shared/error.js";

export const ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/** 10 MB ceiling — large enough for full-screen retina screenshots, small enough
 *  that an accidental paste of a giant raw image can't fill the disk. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SaveImageInput {
  sessionId: string;
  mimeType: AttachmentMimeType;
  dataBase64: string;
}

export interface SaveImageResult {
  filePath: string;
  sizeBytes: number;
}

export class AttachmentStoreError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_MIME" | "TOO_LARGE" | "WRITE_FAILED" | "INVALID_SESSION_ID"
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

function extensionForMime(mime: AttachmentMimeType): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
  }
}

/**
 * Persists composer image attachments under a per-session folder in Electron's
 * userData. Images live outside the worktree so they don't pollute git status
 * and survive worktree teardown — the timeline can keep rendering thumbnails
 * after a workspace is archived.
 */
export class AttachmentStore {
  /** Allows tests to inject a temp dir instead of touching real userData. */
  constructor(private readonly baseDir: string = path.join(app.getPath("userData"), "attachments")) {}

  async saveImage(input: SaveImageInput): Promise<SaveImageResult> {
    if (!ATTACHMENT_MIME_TYPES.includes(input.mimeType)) {
      throw new AttachmentStoreError(`Unsupported mime type: ${input.mimeType}`, "INVALID_MIME");
    }

    const buffer = Buffer.from(input.dataBase64, "base64");
    if (buffer.length === 0) {
      throw new AttachmentStoreError("Empty attachment payload.", "INVALID_MIME");
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentStoreError(
        `Attachment is ${buffer.length} bytes, exceeds ${MAX_ATTACHMENT_BYTES} byte cap.`,
        "TOO_LARGE"
      );
    }

    const sessionDir = path.resolve(this.baseDir, input.sessionId);
    const baseResolved = path.resolve(this.baseDir);
    const baseWithSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
    if (sessionDir !== baseResolved && !sessionDir.startsWith(baseWithSep)) {
      throw new AttachmentStoreError(
        `sessionId resolves outside the attachments root: ${input.sessionId}`,
        "INVALID_SESSION_ID"
      );
    }
    await mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `${randomUUID()}.${extensionForMime(input.mimeType)}`);

    try {
      await writeFile(filePath, buffer);
    } catch (error) {
      throw new AttachmentStoreError(
        `Could not write attachment: ${errorMessage(error)}`,
        "WRITE_FAILED"
      );
    }

    return { filePath, sizeBytes: buffer.length };
  }

  /** Removes every attachment for a session. Idempotent — a missing folder is
   *  not an error. Exposed for housekeeping; not wired today because sessions
   *  are never deleted from the database. */
  async pruneSession(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.baseDir, sessionId);
    await rm(sessionDir, { recursive: true, force: true });
  }
}
