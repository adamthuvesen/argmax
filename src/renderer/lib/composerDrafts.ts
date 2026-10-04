import type { ComposerAttachment } from "../../shared/types.js";
import { isSupportedImageMime } from "./composerAttachments.js";
import { restoreDraftAttachments, restoreDraftText } from "./draftRestore.js";

/** One entry holds every composer's unsent work, keyed by draft key. */
const DRAFTS_KEY = "argmax.composer.drafts";
/**
 * Cap on retained drafts. Object key order is insertion order and a write
 * re-inserts its composer last, so trimming from the front drops the drafts
 * that have gone longest without an edit.
 */
const MAX_DRAFTS = 50;

/**
 * Version written with every stored draft. Version 1 drafts (no field, or a
 * bare string before screenshots) read as they always did. A draft written by
 * a newer build is skipped instead of misread. Chat references need no field
 * of their own: they are links inside `text` (see `composerContext.ts`).
 */
const DRAFT_VERSION = 2;

/**
 * Unsent composer content: the text the user typed plus the screenshots they
 * pasted or dropped. Attachment bytes already live on disk under the
 * attachments root, so a draft only carries the metadata needed to show the
 * chips again and to hand the same files to the agent on send.
 */
interface ComposerDraft {
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
  return key ? readAll().drafts[key] ?? EMPTY : EMPTY;
}

type RestoreHandler = (draft: ComposerDraft) => void;
const restoreHandlers = new Map<string, Set<RestoreHandler>>();

/**
 * A composer showing the draft under `key` says so, so a draft put back after a
 * failed send reaches the composer the person is looking at. Without this a
 * launcher opened in the meantime holds its own state for the key and would
 * write over what storage was given.
 */
export function subscribeDraftRestore(key: string, handler: RestoreHandler): () => void {
  const handlers = restoreHandlers.get(key) ?? new Set<RestoreHandler>();
  handlers.add(handler);
  restoreHandlers.set(key, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) restoreHandlers.delete(key);
  };
}

/**
 * Put a draft back under `key` after a send that emptied it failed. Every
 * composer showing that key merges it into what it holds (above anything typed
 * since); with none showing, it is merged into storage, where the next one for
 * that key reads it. True when a composer on screen took it.
 */
export function restoreDraft(key: string, draft: ComposerDraft): boolean {
  const handlers = restoreHandlers.get(key);
  if (handlers && handlers.size > 0) {
    for (const handler of handlers) handler(draft);
    return true;
  }
  const stored = readDraft(key);
  writeDraftText(key, restoreDraftText(stored.text, draft.text));
  writeDraftAttachments(key, restoreDraftAttachments(stored.attachments, draft.attachments));
  return false;
}

export function writeDraftText(key: string, text: string): void {
  updateDraft(key, (draft) => ({ ...draft, text }));
}

export function writeDraftAttachments(key: string, attachments: ComposerAttachment[]): void {
  updateDraft(key, (draft) => ({ ...draft, attachments }));
}

/**
 * Forget a draft that has been delivered. Call this as soon as send starts,
 * not after it resolves: launching unmounts the composer, and the next mount
 * reads storage. The write effects would recreate the entry from still-held
 * in-memory text unless `persist` is off for that render.
 */
export function clearDraft(key: string): void {
  updateDraft(key, () => ({ text: "", attachments: [] }));
}

function updateDraft(key: string, apply: (draft: ComposerDraft) => ComposerDraft): void {
  const { drafts, newer } = readAll();
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
    // Drafts a newer build wrote are carried through untouched: this build
    // cannot read them, but a downgrade and an upgrade must not cost them.
    const stored: Record<string, unknown> = { ...newer };
    for (const [draftKey, draft] of Object.entries(drafts)) {
      stored[draftKey] = { v: DRAFT_VERSION, ...draft };
    }
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(stored));
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

function readAll(): { drafts: Record<string, ComposerDraft>; newer: Record<string, unknown> } {
  const none = { drafts: {}, newer: {} };
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return none;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none;
    const drafts: Record<string, ComposerDraft> = {};
    const newer: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = parseDraft(value);
      if (draft) drafts[key] = draft;
      else if (isNewerThanThisBuild(value)) newer[key] = value;
    }
    return { drafts, newer };
  } catch {
    // Unreadable storage means "no drafts", never a failed composer mount.
    return none;
  }
}

function isNewerThanThisBuild(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { v } = value as { v?: unknown };
  return typeof v === "number" && v > DRAFT_VERSION;
}

function parseDraft(value: unknown): ComposerDraft | null {
  // Drafts written before screenshots joined them are a bare text string.
  if (typeof value === "string") return { text: value, attachments: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, text, attachments } = value as { v?: unknown; text?: unknown; attachments?: unknown };
  if (typeof text !== "string") return null;
  if (typeof v === "number" && v > DRAFT_VERSION) return null;
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
