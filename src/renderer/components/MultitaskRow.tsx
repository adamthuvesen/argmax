import type { JSX } from "react";
import type { MultitaskNotice } from "../lib/multitask.js";
import { WorkingNest } from "./WorkingNest.js";

type RowStatus = "running" | "done" | "error";

function rowStatus(state: string | null): RowStatus {
  if (state === null) return "running";
  return state === "failed" || state === "cancelled" ? "error" : "done";
}

function statusLabel(notice: MultitaskNotice, status: RowStatus): string {
  if (status === "running") return "Running alongside";
  if (status === "done") return "Finished alongside";
  return notice.state === "cancelled" ? "Stopped" : "Failed";
}

/**
 * A multitask in the chat that dispatched it, shaped like the subagent launch
 * rows above it — because that is what it is to the reader: work running
 * alongside this turn, opened in the same dock, not another chat in the
 * sidebar. The row says what it is doing; the answer and everything else lives
 * in the dock tab it opens.
 */
export function MultitaskRow({
  notice,
  onOpen
}: {
  notice: MultitaskNotice;
  onOpen?: (sessionId: string) => void;
}): JSX.Element {
  const status = rowStatus(notice.state);
  const childSessionId = notice.childSessionId;
  const identity = notice.worktree ? "Multitask · isolated" : "Multitask";
  const headline = (
    <>
      <span className="agent-launch-headline">
        <span className="agent-launch-title">{notice.taskLabel}</span>
        <span className="agent-launch-identity">{identity}</span>
      </span>
      <span className="agent-launch-status">{statusLabel(notice, status)}</span>
    </>
  );

  return (
    <div className="agent-launch-list multitask-row">
      <div className="agent-launch-row" data-status={status}>
        <div className="agent-launch-row-main">
          {status === "running" ? (
            <WorkingNest
              active
              className="agent-launch-mark"
              size={14}
              phaseKey={childSessionId ?? notice.taskLabel}
            />
          ) : (
            <span
              className="agent-launch-mark agent-launch-bullet"
              aria-hidden="true"
              data-launch-mark={status === "error" ? "error" : "done"}
            />
          )}
          {childSessionId && onOpen ? (
            <button
              type="button"
              className="agent-launch-row-button"
              aria-label={`Open multitask: ${notice.taskLabel}`}
              title={notice.prompt ?? notice.taskLabel}
              onClick={() => onOpen(childSessionId)}
            >
              {headline}
            </button>
          ) : (
            <span className="agent-launch-row-button" title={notice.prompt ?? notice.taskLabel}>
              {headline}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
