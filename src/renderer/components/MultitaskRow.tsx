import { Split, Square, X } from "lucide-react";

import { AgentEmblem } from "./AgentEmblem.js";
import { emblemForKey } from "../lib/agentEmblems.js";
import type { JSX } from "react";
import { useSettleHold } from "../hooks/useSettleHold.js";
import { multitaskAnswerPreview, multitaskRowStatus, type MultitaskNotice } from "../lib/multitask.js";
import { WORKING_NEST_SETTLE_MS, WorkingNest } from "./WorkingNest.js";

type RowStatus = "running" | "done" | "error";

/** The subagent launch words, plus the one a subagent has no equivalent for:
 *  a multitask is a chat, so a person can stop it. */
function statusLabel(state: string | null, status: RowStatus): string {
  // A blocked chat is waiting on a person, and its approval lives in the pane,
  // not the dock — saying "Running" here left it stuck with no explanation.
  if (state === "blocked") return "Waiting for you";
  if (status === "running") return "Running";
  if (status === "done") return "Completed";
  return state === "cancelled" ? "Stopped" : "Failed";
}

/**
 * A multitask attached above the chat's composer, drawn in the same launch-row
 * shape as a subagent. It stays visible after the parent turn ends and opens in
 * the same dock, without becoming another chat in the sidebar.
 *
 * The one thing that separates it from a subagent row is the mark a settled
 * one carries: the same emblem its dock tab uses, so both surfaces name a
 * multitask the same way.
 */
export function MultitaskRow({
  notice,
  liveState,
  liveLabel,
  onDismiss,
  onOpen,
  onStop
}: {
  notice: MultitaskNotice;
  /** The child session's own state, when it is still in the snapshot. It beats
   *  the timeline, which only knows what was written: a multitask whose finish
   *  row never landed (the app went down mid-turn) would otherwise claim to be
   *  running forever. */
  liveState?: string | null;
  /** Its workspace's label, for the same reason: the dispatch row was written
   *  with the first line of the prompt, and the short title that replaces it is
   *  minted a second or two later. */
  liveLabel?: string | null;
  /** Closes a settled row. Its chat stays reachable from the dock. */
  onDismiss?: () => void;
  onOpen?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
}): JSX.Element {
  const state = liveState ?? notice.state;
  const taskLabel = liveLabel || notice.taskLabel;
  const status = multitaskRowStatus(state);
  // Hold the nest through its landing before the split glyph takes the slot.
  // A stopped or failed multitask skips it: the landing marks work arriving.
  const markPhase = useSettleHold(status === "running", WORKING_NEST_SETTLE_MS);
  const childSessionId = notice.childSessionId;
  const identity = notice.worktree ? "Multitask · isolated" : "Multitask";
  // What it found, in one line, so a finished multitask says something more
  // than that it finished. The whole answer is a click away in its dock tab.
  // Only while it is settled: answering it again in the dock puts it back to
  // running, and the old result beside a live status reads as this turn's.
  const answer = status === "running" ? null : multitaskAnswerPreview(notice.answer);
  const headline = (
    <>
      <span className="agent-launch-headline">
        <span className="agent-launch-title">{taskLabel}</span>
        <span className="agent-launch-identity">{identity}</span>
      </span>
      <span className="agent-launch-status">
        {statusLabel(state, status)}
        {answer ? <span className="multitask-row-answer"> · {answer}</span> : null}
      </span>
    </>
  );

  return (
    <div className="agent-launch-list multitask-row">
      <div className="agent-launch-row" data-status={status}>
        <div className="agent-launch-row-main">
          {status !== "error" && markPhase !== "done" ? (
            <WorkingNest
              active={markPhase === "running"}
              className="agent-launch-mark"
              size={14}
              phaseKey={childSessionId ?? taskLabel}
            />
          ) : (
            <span className="agent-launch-mark multitask-row-mark" aria-hidden="true">
              {childSessionId ? (
                <AgentEmblem {...emblemForKey(childSessionId)} size={13} status="done" />
              ) : (
                // Dispatched but not yet launched: there is no session id to
                // hash, so the kind's glyph stands in until there is.
                <Split size={13} />
              )}
            </span>
          )}
          {childSessionId && onOpen ? (
            <button
              type="button"
              className="agent-launch-row-button"
              aria-label={`Open multitask: ${taskLabel}`}
              title={notice.prompt ?? taskLabel}
              onClick={() => onOpen(childSessionId)}
            >
              {headline}
            </button>
          ) : (
            <span className="agent-launch-row-button" title={notice.prompt ?? taskLabel}>
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
              aria-label={`Stop multitask: ${taskLabel}`}
              title="Stop this multitask"
              onClick={() => onStop(childSessionId)}
            >
              <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button>
          ) : null}
          {/* Once it has settled, the row has said its piece: closing it clears
              the lane without losing the chat, which its dock tab still holds. */}
          {status !== "running" && onDismiss ? (
            <button
              type="button"
              className="multitask-row-stop multitask-row-dismiss"
              aria-label={`Dismiss multitask: ${taskLabel}`}
              title="Dismiss this multitask"
              onClick={onDismiss}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
