import type { JSX } from "react";
import type { ProviderSwitchNotice as Notice } from "../lib/providerSwitch.js";

/**
 * The seam where a session changed hands. Everything below it was written by a
 * different agent, working from the transcript rather than the previous
 * agent's own session — worth showing for the same reason a compaction seam
 * is. See lib/providerSwitch.ts.
 */
export function ProviderSwitchNotice({ notice }: { notice: Notice }): JSX.Element {
  const label = notice.from ? `${notice.from} → ${notice.to}` : `Switched to ${notice.to}`;
  return (
    <div
      className="conversation-notice"
      role="status"
      aria-live="polite"
      aria-label={notice.modelLabel ? `${label}, ${notice.modelLabel}` : label}
    >
      <span className="conversation-notice-rule" aria-hidden="true" />
      <span className="conversation-notice-text" aria-hidden="true">
        {label}
        {notice.modelLabel ? (
          <span className="conversation-notice-detail"> · {notice.modelLabel}</span>
        ) : null}
      </span>
      <span className="conversation-notice-rule" aria-hidden="true" />
    </div>
  );
}
