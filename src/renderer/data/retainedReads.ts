import type { DashboardDelta } from "../../shared/types.js";

/**
 * Bridge replies kept after the component that read them unmounts.
 *
 * Selecting a chat remounts its whole pane, so every read a pane makes on
 * mount runs again on every switch. A reply kept here lets the remount show it
 * at once and skip the read. Each entry is keyed by what the reply depends on,
 * so a key that changed is a miss. An entry is also dropped on a dashboard
 * resync, and on any delta its `dropOn` names.
 *
 * A read in flight is tracked the same way: a delta or a forget that would
 * drop its entry marks it, and its reply is then not kept, because the reply
 * may predate the change.
 */

type DropOn = (delta: DashboardDelta) => boolean;

interface Entry {
  data: unknown;
  dropOn: DropOn | null;
}

interface PendingRead {
  key: string;
  dropOn: DropOn | null;
  stale: boolean;
}

export interface RetainedRead<T> {
  /** Keeps the reply, unless a change that drops this key landed during the read. */
  keep: (data: T) => void;
  /** The read failed or was superseded: keep nothing. */
  discard: () => void;
}

// No measured source: it bounds memory, and a working set of chats is far
// smaller (a switch keeps about ten reads per chat).
const ENTRY_LIMIT = 512;

const entries = new Map<string, Entry>();
const pending = new Set<PendingRead>();
let unsubscribe: (() => void) | null = null;

function subscribe(): void {
  if (unsubscribe) return;
  const onDelta = typeof window !== "undefined" ? window.argmax?.dashboard?.onDelta : undefined;
  if (!onDelta) return;
  unsubscribe = onDelta((delta) => {
    for (const [key, entry] of entries) {
      if (delta.resyncRequired || entry.dropOn?.(delta)) entries.delete(key);
    }
    for (const read of pending) {
      if (delta.resyncRequired || read.dropOn?.(delta)) read.stale = true;
    }
  });
}

export function retainedReply<T>(key: string): { data: T } | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  // Re-insert so the map's order is least recently used first.
  entries.delete(key);
  entries.set(key, entry);
  return { data: entry.data as T };
}

/** Keeps a reply that is current now, such as a local write. */
export function retainReply<T>(key: string, data: T, dropOn: DropOn | null = null): void {
  subscribe();
  entries.delete(key);
  entries.set(key, { data, dropOn });
  if (entries.size > ENTRY_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** Call when a read starts, then settle it through the returned handle. */
export function startRetainedRead<T>(key: string, dropOn: DropOn | null = null): RetainedRead<T> {
  subscribe();
  const read: PendingRead = { key, dropOn, stale: false };
  pending.add(read);
  return {
    keep: (data) => {
      if (!pending.delete(read) || read.stale) return;
      retainReply(key, data, dropOn);
    },
    discard: () => {
      pending.delete(read);
    },
  };
}

export function forgetRetained(matches: (key: string) => boolean): void {
  for (const key of entries.keys()) if (matches(key)) entries.delete(key);
  for (const read of pending) if (matches(read.key)) read.stale = true;
}

/** Test isolation: a reply one test kept must not decide what the next one renders. */
export function forgetAllRetained(): void {
  entries.clear();
  pending.clear();
  unsubscribe?.();
  unsubscribe = null;
}
