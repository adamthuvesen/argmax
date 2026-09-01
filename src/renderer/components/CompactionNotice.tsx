import type { JSX } from "react";
import type { CompactionNotice as Notice } from "../lib/compaction.js";
import { formatTokens } from "../formatTokens.js";

/**
 * The whole visible trace of a context compaction: a seam in the transcript
 * with the before/after context size when the provider reported it. The
 * provider's replacement summary is written for the model and never renders.
 * see lib/compaction.ts.
 */
export function CompactionNotice({ notice }: { notice: Notice }): JSX.Element {
  const sizes =
    notice.preTokens !== null && notice.postTokens !== null
      ? `${formatTokens(notice.preTokens)} → ${formatTokens(notice.postTokens)}`
      : null;
  // Running says only "Compacting…": it is the pane's one live line, and the
  // shorter word carries the pulse better. The settled seam keeps the noun,
  // where it sits beside the before/after sizes.
  const label = notice.running ? "Compacting" : "Compacted context";
  return (
    <div
      className="conversation-notice"
      data-running={notice.running ? "true" : undefined}
      role="status"
      aria-live="polite"
      aria-label={sizes ? `${label}, ${sizes} tokens` : label}
    >
      <span className="conversation-notice-rule" aria-hidden="true" />
      <span className="conversation-notice-text" aria-hidden="true">
        {notice.running ? `${label}…` : label}
        {sizes ? <span className="conversation-notice-detail"> · {sizes}</span> : null}
      </span>
      <span className="conversation-notice-rule" aria-hidden="true" />
    </div>
  );
}
