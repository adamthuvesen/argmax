import type { JSX } from "react";
import type { ProjectMoveNotice as Notice } from "../lib/projectMove.js";

export function ProjectMoveNotice({ notice }: { notice: Notice }): JSX.Element {
  const label = notice.from ? `${notice.from} → ${notice.to}` : `Moved to ${notice.to}`;
  const details = [
    notice.checkoutMode === "worktree"
      ? "isolated worktree"
      : notice.checkoutMode === "shared"
        ? "shared checkout"
        : null,
    notice.sourceArchiveState === "kept" ? "source kept" : null
  ].filter((detail): detail is string => detail !== null);
  const accessibleLabel = details.length > 0 ? `${label}, ${details.join(", ")}` : label;

  return (
    <div
      className="conversation-notice"
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
    >
      <span className="conversation-notice-rule" aria-hidden="true" />
      <span className="conversation-notice-text" aria-hidden="true">
        {label}
        {details.length > 0 ? (
          <span className="conversation-notice-detail"> · {details.join(" · ")}</span>
        ) : null}
      </span>
      <span className="conversation-notice-rule" aria-hidden="true" />
    </div>
  );
}
