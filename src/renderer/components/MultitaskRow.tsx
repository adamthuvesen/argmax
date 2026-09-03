import { Square } from "lucide-react";
import type { JSX } from "react";
import type { MultitaskNotice } from "../lib/multitask.js";
import { WorkingNest } from "./WorkingNest.js";

type RowStatus = "running" | "done" | "error";

function rowStatus(state: string | null): RowStatus {
  if (state === null) return "running";
  if (state === "running" || state === "waiting" || state === "blocked") return "running";
  return state === "failed" || state === "cancelled" ? "error" : "done";
}

function statusLabel(state: string | null, status: RowStatus): string {
  if (status === "running") return "Running alongside";
  if (status === "done") return "Finished alongside";
  return state === "cancelled" ? "Stopped" : "Failed";
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
  liveState,
  onOpen,
  onStop
}: {
  notice: MultitaskNotice;
  /** The child session's own state, when it is still in the snapshot. It beats
   *  the timeline, which only knows what was written: a multitask whose finish
   *  row never landed (the app went down mid-turn) would otherwise claim to be
   *  running forever. */
  liveState?: string | null;
  onOpen?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
}): JSX.Element {
  const state = liveState ?? notice.state;
  const status = rowStatus(state);
  const childSessionId = notice.childSessionId;
  const identity = notice.worktree ? "Multitask · isolated" : "Multitask";
  const headline = (
    <>
      <span className="agent-launch-headline">
        <span className="agent-launch-title">{notice.taskLabel}</span>
        <span className="agent-launch-identity">{identity}</span>
      </span>
      <span className="agent-launch-status">{statusLabel(state, status)}</span>
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
          {/* Stopping is the one thing you might want without opening it, so it
              rides the row — quiet until the row is hovered or the button is
              tabbed to, the way the tool rows reveal their disclosure. */}
          {status === "running" && childSessionId && onStop ? (
            <button
              type="button"
              className="multitask-row-stop"
              aria-label={`Stop multitask: ${notice.taskLabel}`}
              title="Stop this multitask"
              onClick={() => onStop(childSessionId)}
            >
              <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
