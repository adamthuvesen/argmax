import type { BackendLogEntry } from "../../shared/types.js";

// Breadcrumbs for the chat's progress cue.
//
// The "Thinking" line is the only thing on screen during the ten to thirty
// seconds a relaunched provider takes to say its first word, and it is derived
// from half a dozen suppression rules. When it fails to appear, the pane is
// black and the transcript records nothing about why — the state that decided
// it is gone by the time anyone looks. One line per transition makes the next
// occurrence a single lookup instead of an archaeology session.
//
// Deliberately renderer-local. The Rust ring is fed by `tracing` from the other
// side of the IPC boundary; shipping a line across it per transition would cost
// a round trip to record that nothing happened.

/** Why the cue is not on screen while the session is live. `shown` is the
 *  cue's own state, not a suppressor. */
export type ChatCueReason =
  | "shown"
  | "show-delay"
  | "tool-running"
  | "card-ask"
  | "live-thought"
  | "streaming-text"
  | "answer-settling"
  | "compacting";

/** Enough to cover a long session's worth of transitions without holding a
 *  session's history hostage: the interesting window is always the last few. */
const CAP = 200;

const SCOPE = "renderer::chat";

let entries: BackendLogEntry[] = [];
const listeners = new Set<() => void>();
// Renderer lines share one list with the backend ring, whose `seq` is a
// positive process-lifetime counter. Counting down from zero keeps the two
// sequences from ever colliding on a React key.
let nextSeq = -1;

export function recordChatCue(input: {
  sessionId: string;
  provider: string | null;
  visible: boolean;
  reason: ChatCueReason;
}): void {
  const entry: BackendLogEntry = {
    seq: nextSeq,
    timestamp: new Date().toISOString(),
    // `debug`, not `info`: this is a per-transition trace, and the Logs tab
    // opens at `debug`, so it is visible by default without pushing the
    // backend's own info lines down the list.
    level: "debug",
    scope: SCOPE,
    message: input.visible ? "progress cue shown" : "progress cue hidden",
    fields: {
      sessionId: input.sessionId,
      reason: input.reason,
      ...(input.provider === null ? {} : { provider: input.provider })
    }
  };
  nextSeq -= 1;
  const next = entries.length >= CAP ? entries.slice(entries.length - CAP + 1) : entries.slice();
  next.push(entry);
  entries = next;
  for (const listener of listeners) listener();
}

export function subscribeChatCueLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between pushes, so `useSyncExternalStore` does not loop. */
export function chatCueLogSnapshot(): BackendLogEntry[] {
  return entries;
}

export function clearChatCueLog(): void {
  entries = [];
  nextSeq = -1;
  for (const listener of listeners) listener();
}
