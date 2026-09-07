import type { BackendLogEntry } from "../../shared/types.js";

// One ring for every renderer-side breadcrumb, merged into the backend's
// `tracing` ring in the debug panel's Logs tab.
//
// These lines stay on this side of the IPC boundary deliberately: a round trip
// per transition to record that nothing happened is not worth its cost. The
// scope names the subsystem — `renderer::chat` for the progress cue,
// `renderer::drag` for drag and drop — so the tab's scope filter separates
// them without a second list.

/** Enough to cover a long session's worth of transitions without holding a
 *  session's history hostage: the interesting window is always the last few. */
const CAP = 200;

let entries: BackendLogEntry[] = [];
const listeners = new Set<() => void>();
// Renderer lines share one list with the backend ring, whose `seq` is a
// positive process-lifetime counter. Counting down from zero keeps the two
// sequences from ever colliding on a React key.
let nextSeq = -1;

export function recordRendererLog(input: {
  scope: string;
  message: string;
  /** `debug` unless the line is a diagnosis on its own. The Logs tab opens at
   *  `debug`, so both are visible without touching the filter. */
  level?: "debug" | "warn";
  fields: Record<string, string>;
}): void {
  const entry: BackendLogEntry = {
    seq: nextSeq,
    timestamp: new Date().toISOString(),
    level: input.level ?? "debug",
    scope: input.scope,
    message: input.message,
    fields: input.fields
  };
  nextSeq -= 1;
  const next = entries.length >= CAP ? entries.slice(entries.length - CAP + 1) : entries.slice();
  next.push(entry);
  entries = next;
  for (const listener of listeners) listener();
}

export function subscribeRendererLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between pushes, so `useSyncExternalStore` does not loop. */
export function rendererLogSnapshot(): BackendLogEntry[] {
  return entries;
}

export function clearRendererLog(): void {
  entries = [];
  nextSeq = -1;
  for (const listener of listeners) listener();
}
