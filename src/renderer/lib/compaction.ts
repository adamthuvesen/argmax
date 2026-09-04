import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

/**
 * Context compaction is a provider-side rewrite of the conversation: the agent
 * summarizes everything so far and continues from the summary. Claude brackets
 * it with two rows the normalizer maps to these types, and the summary body
 * itself is dropped (providers/normalizer/claude.rs). The chat shows the seam,
 * not the summary. The summary is written for the model, and at tens of KB it
 * buries the actual conversation.
 */
export interface CompactionNotice {
  /** Compaction is still running. It can take minutes of total silence. */
  running: boolean;
  /** Context size before/after, when the provider reported them. */
  preTokens: number | null;
  postTokens: number | null;
}

export function isCompactionEvent(event: TimelineEvent): boolean {
  const canonical = decodeTimelineEvent(event);
  return canonical.kind === "lifecycle" &&
    (canonical.name === "compacting" || canonical.name === "compacted");
}

export function compactionNoticeFor(event: TimelineEvent): CompactionNotice {
  const canonical = decodeTimelineEvent(event);
  if (
    canonical.kind !== "lifecycle" ||
    (canonical.name !== "compacting" && canonical.name !== "compacted")
  ) {
    return { running: false, preTokens: null, postTokens: null };
  }
  return {
    running: canonical.name === "compacting",
    preTokens: canonical.preTokens,
    postTokens: canonical.postTokens
  };
}

/**
 * True while a compaction is in flight. `events` is newest-first (the order
 * the dashboard merge keeps), so the newest compaction row decides.
 */
export function isCompacting(events: readonly TimelineEvent[]): boolean {
  const newest = events.find(isCompactionEvent);
  if (!newest) return false;
  const canonical = decodeTimelineEvent(newest);
  return canonical.kind === "lifecycle" && canonical.name === "compacting";
}
