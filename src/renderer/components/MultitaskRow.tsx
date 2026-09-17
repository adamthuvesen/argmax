import { Split, Square, X } from "lucide-react";

import { AgentEmblem } from "./AgentEmblem.js";
import { emblemForKey } from "../lib/agentEmblems.js";
import { useRef, type JSX } from "react";
import { multitaskAnswerPreview, multitaskRowStatus, type MultitaskNotice } from "../lib/multitask.js";
import { usePacedHeadline } from "../lib/pacedHeadline.js";
import { useReadingWave } from "../lib/readingWave.js";

type RowStatus = "running" | "done" | "error";

/** As in AgentLaunchList: the row's parts joined into the one string
 *  `usePacedHeadline` paces, on a delimiter a task title cannot contain. */
const PART = "\u0000";

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
 * The one thing that separates it from a subagent row is the mark it carries:
 * the same emblem its dock tab uses, so both surfaces name a multitask the
 * same way.
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
  const childSessionId = notice.childSessionId;
  const identity = notice.worktree ? "Multitask · isolated" : "Multitask";
  // What it found, in one line, so a finished multitask says something more
  // than that it finished. The whole answer is a click away in its dock tab.
  // Only while it is settled: answering it again in the dock puts it back to
  // running, and the old result beside a live status reads as this turn's.
  const answer = status === "running" ? null : multitaskAnswerPreview(notice.answer);
  // One wording for the row, paced as the transcript paces a running headline:
  // the dispatch title and the short one its chat is given land seconds apart,
  // and a chat that blocks on an approval flips its status word back and forth
  // while it runs. Both are held to one change per beat, newest wording wins.
  const wording = [taskLabel, identity, statusLabel(state, status)].join(PART);
  const paced = usePacedHeadline(wording, wording, status === "running");
  const [shownLabel, shownIdentity, shownStatus] = paced.shown.split(PART);
  const previousParts = paced.previous.split(PART);
  const arriving = (index: number, part: string): "true" | undefined =>
    previousParts[index] !== part ? "true" : undefined;
  const headlineRef = useRef<HTMLSpanElement | null>(null);
  useReadingWave(headlineRef, status === "running", `${shownLabel}${PART}${shownIdentity}`);
  const headline = (
    <>
      <span
        className="agent-launch-headline"
        ref={headlineRef}
        data-reading-wave={status === "running" ? "true" : undefined}
      >
        <span
          key={shownLabel}
          className="agent-launch-title reading-wave-text"
          data-arriving={arriving(0, shownLabel)}
        >
          {shownLabel}
        </span>
        <span
          key={shownIdentity}
          className="agent-launch-identity reading-wave-text"
          data-arriving={arriving(1, shownIdentity)}
        >
          {shownIdentity}
        </span>
      </span>
      <span
        key={shownStatus}
        className="agent-launch-status"
        data-arriving={arriving(2, shownStatus)}
      >
        {shownStatus}
        {answer ? <span className="multitask-row-answer"> · {answer}</span> : null}
      </span>
    </>
  );

  return (
    <div className="agent-launch-list multitask-row">
      <div className="agent-launch-row" data-status={status}>
        <div className="agent-launch-row-main">
          {/* The emblem whatever the chat is doing, as the dock tab shows it.
              The row says it is live on its own words (the reading wave), so a
              nest here would mark the same thing twice. */}
          <span className="agent-launch-mark multitask-row-mark" aria-hidden="true">
            {childSessionId ? (
              <AgentEmblem {...emblemForKey(childSessionId)} size={13} status="done" />
            ) : (
              // Dispatched but not yet launched: there is no session id to
              // hash, so the kind's glyph stands in until there is.
              <Split size={13} />
            )}
          </span>
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
