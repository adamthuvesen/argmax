import { Square, X } from "lucide-react";
import { useLayoutEffect, useRef, type JSX } from "react";

import type { SessionSummary } from "../../shared/types.js";
import { formatElapsedSeconds } from "../formatElapsed.js";
import { useMultitaskAsk } from "../hooks/useMultitaskAsk.js";
import { registerLiveTimer } from "../lib/liveTimer.js";
import { multitaskDisplayStatus, type MultitaskDisplayStatus, type MultitaskNotice } from "../lib/multitask.js";
import { useReadingWave } from "../lib/readingWave.js";

const STATUS_LABEL: Record<MultitaskDisplayStatus, string> = {
  running: "Running",
  done: "Finished",
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Stopped"
};

/** The state, drawn: a dot while it runs, a check when it lands, a question
 *  mark while it waits on you, a cross when it failed or was stopped. */
function MultitaskMark({ status }: { status: MultitaskDisplayStatus }): JSX.Element {
  return (
    <span className="multitask-mark" role="img" aria-label={STATUS_LABEL[status]}>
      {status === "running" ? <i className="multitask-mark-dot" /> : null}
      {status === "done" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
      ) : null}
      {status === "needs-you" ? <span aria-hidden="true">?</span> : null}
      {status === "failed" || status === "stopped" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
          <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * One chat running alongside this one, as a row in the card above the
 * composer: mark, title, state. The whole row opens the chat; the one thing
 * you can do to it from here — stop it while it runs, close it once it has
 * settled — sits in a reserved seat at the end, quiet until the row is
 * hovered or the button is tabbed to, so nothing shifts when it appears.
 */
export function MultitaskRow({
  notice,
  liveState,
  liveAttention,
  liveApprovalCommand,
  liveStartedAt,
  liveLabel,
  onOpen,
  onStop,
  onDismiss,
  onLoadSessionEvents
}: {
  notice: MultitaskNotice;
  liveState?: string | null;
  liveAttention?: SessionSummary["attention"] | null;
  /** The command a pending approval wants to run, from the dashboard's
   *  approvals: an approval never reaches the child's transcript. */
  liveApprovalCommand?: string | null;
  /** When its turn started. A running row counts from it in place of the
   *  word: the dot and the colour already say running, the count says how
   *  long, which is what you glance at a running side task for. */
  liveStartedAt?: string | null;
  liveLabel?: string | null;
  onOpen?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  /** Closes a settled row; it takes the stop button's seat once stop is gone. */
  onDismiss?: (sessionId: string) => void;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
}): JSX.Element {
  const state = liveState ?? notice.state;
  const status = multitaskDisplayStatus(state, liveAttention);
  const taskLabel = liveLabel || notice.taskLabel;
  const childSessionId = notice.childSessionId;
  // What it is waiting on, so "Needs you" says what for. An approval's command
  // rides the dashboard; a question lives in the child's own transcript and is
  // read only while a question is the reason — a running or finished row
  // subscribes to nothing.
  const question = useMultitaskAsk(
    childSessionId,
    status === "needs-you" && liveAttention === "question-asked",
    onLoadSessionEvents
  );
  const ask = status !== "needs-you"
    ? null
    : liveAttention === "approval-needed" && liveApprovalCommand
      ? { kind: "approval" as const, text: liveApprovalCommand }
      : question
        ? { kind: "question" as const, text: question }
        : null;
  const reading = state === "running" && status === "running";
  const labelRef = useRef<HTMLSpanElement | null>(null);
  useReadingWave(labelRef, reading, taskLabel);
  // The count ticks on the shared once-a-second timer, written straight to
  // the node so the row never re-renders for it. Whole seconds, as the turn
  // header counts. Only a running row with a known start counts; the rest
  // say their word.
  const startedMs = reading && liveStartedAt ? Date.parse(liveStartedAt) : NaN;
  const counting = Number.isFinite(startedMs);
  const elapsedRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const node = elapsedRef.current;
    if (!node || !counting) return;
    return registerLiveTimer(node, () => Date.now() - startedMs, formatElapsedSeconds);
  }, [counting, startedMs]);
  const canStop = (state === "running" || state === null || state === "waiting" || state === "blocked") && childSessionId && onStop;
  const canDismiss = !canStop && (status === "done" || status === "failed" || status === "stopped") && childSessionId && onDismiss;

  const contents = (
    <>
      <MultitaskMark status={status} />
      <span className="multitask-row-body">
        <span className="multitask-row-title-line">
          <span className="multitask-row-title" ref={labelRef} data-reading-wave={reading ? "true" : undefined}>
            {reading ? <span className="reading-wave-text">{taskLabel}</span> : taskLabel}
          </span>
          {notice.worktree ? <span className="multitask-row-isolated">isolated</span> : null}
        </span>
        {ask ? (
          <span className="multitask-row-ask" data-kind={ask.kind} title={ask.text}>
            {ask.kind === "approval" ? <span className="multitask-row-ask-lead">Wants to run</span> : null}
            <span className="multitask-row-ask-text">{ask.text}</span>
          </span>
        ) : null}
      </span>
      {counting ? (
        <span className="multitask-row-state" ref={elapsedRef} aria-label="Running for" />
      ) : (
        <span className="multitask-row-state">{STATUS_LABEL[status]}</span>
      )}
    </>
  );

  return (
    <li className="multitask-row" data-status={status}>
      {childSessionId && onOpen ? (
        <button type="button" className="multitask-row-open" aria-label={`Open multitask: ${taskLabel}`} title={notice.prompt ?? taskLabel} onClick={() => onOpen(childSessionId)}>
          {contents}
        </button>
      ) : (
        <span className="multitask-row-open" title={notice.prompt ?? taskLabel}>{contents}</span>
      )}
      <span className="multitask-row-seat">
        {canStop ? (
          <button type="button" className="multitask-row-action" aria-label={`Stop multitask: ${taskLabel}`} title="Stop this multitask" onClick={() => onStop(childSessionId)}>
            <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          </button>
        ) : canDismiss ? (
          <button type="button" className="multitask-row-action" aria-label={`Dismiss multitask: ${taskLabel}`} title="Dismiss this multitask" onClick={() => onDismiss(childSessionId)}>
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </li>
  );
}
