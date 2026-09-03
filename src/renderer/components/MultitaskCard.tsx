import { ArrowUpRight, GitBranch, Square } from "lucide-react";
import type { JSX } from "react";
import type { MultitaskNotice } from "../lib/multitask.js";

/**
 * A multitask as it appears in the chat that dispatched it: a card anchored
 * where the person asked for it, which fills in when the work finishes rather
 * than being replaced by a separate marker somewhere further down.
 *
 * It never interrupts. The turn it was dispatched from keeps running above it,
 * and the finished answer is a line here — the parent's agent only hears about
 * it on the next thing the person types.
 */
export function MultitaskCard({
  notice,
  onOpenSession,
  onTerminateSession
}: {
  notice: MultitaskNotice;
  onOpenSession?: (sessionId: string) => void;
  onTerminateSession?: (sessionId: string) => void | Promise<void>;
}): JSX.Element {
  const running = notice.state === null;
  const failed = notice.state === "failed" || notice.state === "cancelled";
  const status = running ? "Running alongside" : failed ? `Stopped (${notice.state})` : "Finished alongside";
  const childSessionId = notice.childSessionId;

  return (
    <section
      className={`multitask-card${running ? " running" : ""}${failed ? " failed" : ""}`}
      aria-label={`Multitask: ${notice.taskLabel} — ${status.toLowerCase()}`}
    >
      <header className="multitask-card-header">
        <span className={`multitask-card-dot${running ? " running" : ""}`} aria-hidden="true" />
        <span className="multitask-card-status">{status}</span>
        <span className="multitask-card-label" title={notice.prompt ?? notice.taskLabel}>
          {notice.taskLabel}
        </span>
        {notice.worktree ? (
          <span className="multitask-card-badge" title="Runs in its own worktree">
            <GitBranch size={12} aria-hidden="true" />
            Isolated
          </span>
        ) : null}
        <span className="multitask-card-actions">
          {running && childSessionId && onTerminateSession ? (
            <button
              type="button"
              className="multitask-card-action"
              aria-label={`Stop multitask: ${notice.taskLabel}`}
              title="Stop this multitask"
              onClick={() => void onTerminateSession(childSessionId)}
            >
              <Square size={12} aria-hidden="true" />
              Stop
            </button>
          ) : null}
          {childSessionId && onOpenSession ? (
            <button
              type="button"
              className="multitask-card-action"
              aria-label={`Open multitask chat: ${notice.taskLabel}`}
              title="Open the chat it is running in"
              onClick={() => onOpenSession(childSessionId)}
            >
              Open
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </header>
      {notice.answer ? <p className="multitask-card-answer">{notice.answer}</p> : null}
    </section>
  );
}
