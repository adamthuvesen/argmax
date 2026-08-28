import type { EventType, TimelineEvent } from "../../shared/types.js";

/**
 * Context compaction is a provider-side rewrite of the conversation: the agent
 * summarizes everything so far and continues from the summary. Claude brackets
 * it with two rows the normalizer maps to these types, and the summary body
 * itself is dropped (providers/normalizer/claude.rs). The chat shows the seam,
 * not the summary. The summary is written for the model, and at tens of KB it
 * buries the actual conversation.
 */
export const COMPACTION_STARTED: EventType = "session.compacting";
export const COMPACTION_FINISHED: EventType = "session.compacted";

export interface CompactionNotice {
  /** Compaction is still running. It can take minutes of total silence. */
  running: boolean;
  /** Context size before/after, when the provider reported them. */
  preTokens: number | null;
  postTokens: number | null;
}

export function isCompactionEvent(event: TimelineEvent): boolean {
  return event.type === COMPACTION_STARTED || event.type === COMPACTION_FINISHED;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function compactionNoticeFor(event: TimelineEvent): CompactionNotice {
  return {
    running: event.type === COMPACTION_STARTED,
    preTokens: tokenCount(event.payload.preTokens),
    postTokens: tokenCount(event.payload.postTokens)
  };
}

/**
 * True while a compaction is in flight. `events` is newest-first (the order
 * the dashboard merge keeps), so the newest compaction row decides.
 */
export function isCompacting(events: readonly TimelineEvent[]): boolean {
  return events.find(isCompactionEvent)?.type === COMPACTION_STARTED;
}
