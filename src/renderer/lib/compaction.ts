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

function isCompactionEvent(event: TimelineEvent): boolean {
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
 * A row that can land during a compaction without the parent having said a
 * word: a spawned child agent's own rows (Codex forwards a child's tool calls
 * and answer while the parent is mid-rewrite), and a tool result, including
 * the spawn call's completion carrying that child's answer, for a call that
 * predates the rewrite.
 */
function landsDuringCompaction(event: TimelineEvent): boolean {
  if (event.type === "command.completed") return true;
  const canonical = decodeTimelineEvent(event);
  return canonical.parentToolUseId !== null ||
    canonical.providerThreadId !== null ||
    canonical.providerChildSessionId !== null;
}

/**
 * True while a compaction is in flight. `events` is newest-first (the order
 * the dashboard merge keeps).
 *
 * A compaction is silence from the parent, so its start row stays the newest
 * thing the parent produced for as long as it runs: any newer row of its own
 * means the rewrite is over. That is the only evidence a compaction cut short
 * by a Stop leaves — it never gets its closing row, and a start row trusted
 * forever suppresses the progress cue for the rest of the chat's life. Rows
 * that are not the parent's (see `landsDuringCompaction`) do not count, or a
 * chat with children running showed a Thinking clock under "Compacting…".
 */
export function isCompacting(events: readonly TimelineEvent[]): boolean {
  for (const event of events) {
    if (isCompactionEvent(event)) {
      const canonical = decodeTimelineEvent(event);
      return canonical.kind === "lifecycle" && canonical.name === "compacting";
    }
    if (!landsDuringCompaction(event)) return false;
  }
  return false;
}
