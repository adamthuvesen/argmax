import type { ComposerAttachment } from "../../shared/types.js";
import { isSupportedImageMime } from "./composerAttachments.js";

/** One entry holds every composer's unsent work, keyed by draft key. */
const DRAFTS_KEY = "argmax.composer.drafts";
/**
 * Cap on retained drafts. Object key order is insertion order and a write
 * re-inserts its composer last, so trimming from the front drops the drafts
 * that have gone longest without an edit.
 */
const MAX_DRAFTS = 50;

/**
 * Unsent composer content: the text the user typed plus the screenshots they
 * pasted or dropped. Attachment bytes already live on disk under the
 * attachments root, so a draft only carries the metadata needed to show the
 * chips again and to hand the same files to the agent on send.
 */
export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
}

const EMPTY: ComposerDraft = { text: "", attachments: [] };

/**
 * Draft key for a project's new-session launcher. Session composers key by
 * session id, so the `launch-` prefix keeps the two apart. It doubles as the
 * `AttachmentStore` folder name for pre-launch images, which is why it stays a
 * plain path-safe id.
 */
export function launcherDraftKey(projectId: string): string {
  return `launch-${projectId}`;
}

export function readDraft(key: string | null): ComposerDraft {
  return key ? readAll()[key] ?? EMPTY : EMPTY;
}

export function writeDraftText(key: string, text: string): void {
  updateDraft(key, (draft) => ({ ...draft, text }));
}

export function writeDraftAttachments(key: string, attachments: ComposerAttachment[]): void {
  updateDraft(key, (draft) => ({ ...draft, attachments }));
}

/**
 * Forget a draft that has been delivered. Clearing the composer's own state
 * does the same thing through the write effects, but only while the composer
 * is still mounted. Launching a task unmounts the launcher as the app moves
 * to the new session, so the send path drops the entry itself.
 */
export function clearDraft(key: string): void {
  updateDraft(key, () => ({ text: "", attachments: [] }));
}

function updateDraft(key: string, apply: (draft: ComposerDraft) => ComposerDraft): void {
  const drafts = readAll();
  const existing = drafts[key];
  const updated = apply(existing ?? EMPTY);
  // A draft with neither text nor attachments is nothing to remember.
  const next = updated.text.trim() || updated.attachments.length > 0 ? updated : undefined;
  if (isSameDraft(existing, next)) return;
  delete drafts[key];
  if (next) drafts[key] = next;
  const excess = Object.keys(drafts).length - MAX_DRAFTS;
  for (const stale of Object.keys(drafts).slice(0, Math.max(0, excess))) {
    delete drafts[stale];
  }
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // A quota failure costs the user a restored draft, never the send.
  }
}

function isSameDraft(a: ComposerDraft | undefined, b: ComposerDraft | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.text === b.text &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((entry, index) => entry.filePath === b.attachments[index]?.filePath)
  );
}

function readAll(): Record<string, ComposerDraft> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const drafts: Record<string, ComposerDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = parseDraft(value);
      if (draft) drafts[key] = draft;
    }
    return drafts;
  } catch {
    // Unreadable storage means "no drafts", never a failed composer mount.
    return {};
  }
}

function parseDraft(value: unknown): ComposerDraft | null {
  // Drafts written before screenshots joined them are a bare text string.
  if (typeof value === "string") return { text: value, attachments: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { text, attachments } = value as { text?: unknown; attachments?: unknown };
  if (typeof text !== "string") return null;
  return { text, attachments: Array.isArray(attachments) ? attachments.filter(isAttachment) : [] };
}

function isAttachment(value: unknown): value is ComposerAttachment {
  if (typeof value !== "object" || value === null) return false;
  const { filePath, mimeType, sizeBytes } = value as {
    filePath?: unknown;
    mimeType?: unknown;
    sizeBytes?: unknown;
  };
  return (
    typeof filePath === "string" &&
    filePath.length > 0 &&
    typeof mimeType === "string" &&
    isSupportedImageMime(mimeType) &&
    typeof sizeBytes === "number"
  );
}
