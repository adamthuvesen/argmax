import { useId, useState, type JSX } from "react";
import { ChevronDown } from "lucide-react";
import type { SessionSummary } from "../../shared/types.js";
import { multitaskDisplayStatus, type MultitaskNotice } from "../lib/multitask.js";
import { MultitaskRow } from "./MultitaskRow.js";

export type MultitaskLive = {
  state: string;
  taskLabel: string;
  attention: SessionSummary["attention"];
  /** The command its pending approval wants to run, when it is stopped on one. */
  approvalCommand: string | null;
  /** When its turn started, so a running row can count instead of saying "Running". */
  startedAt: string | null;
};

/**
 * The chats running alongside this one, in a card of their own above the
 * composer. The launch turns keep the history, each chat supplies its live
 * state, and the head counts them so the card still says something folded.
 */
export function MultitaskGroup({ notices, live, onOpen, onStop, onDismiss, onLoadSessionEvents }: {
  notices: readonly MultitaskNotice[];
  live?: ReadonlyMap<string, MultitaskLive>;
  onOpen?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  /** Closes a settled row. Its chat stays reachable from the dock. */
  onDismiss?: (sessionId: string) => void;
  /** Fills a child's transcript so a row waiting on a question can quote it. */
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  const counts = { running: 0, "needs-you": 0, done: 0, failed: 0, stopped: 0 };
  for (const notice of notices) {
    const child = notice.childSessionId ? live?.get(notice.childSessionId) : undefined;
    counts[multitaskDisplayStatus(child?.state ?? notice.state, child?.attention)]++;
  }
  const summary = [
    counts.running ? `${counts.running} running` : null,
    counts["needs-you"] ? `${counts["needs-you"]} needs you` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.stopped ? `${counts.stopped} stopped` : null,
    counts.done ? `${counts.done} finished` : null
  ].filter(Boolean).join(" · ");

  return (
    <section className="multitask-card" data-expanded={expanded} aria-label="Multitasks">
      <button
        type="button"
        className="multitask-card-head"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="multitask-card-title">Multitasks</span>
        <span className="multitask-card-count">{summary}</span>
        <ChevronDown size={14} className="multitask-card-chevron" aria-hidden="true" />
      </button>
      <ul id={listId} className="multitask-list" hidden={!expanded}>
        {notices.map((notice) => {
          const child = notice.childSessionId ? live?.get(notice.childSessionId) : undefined;
          return (
            <MultitaskRow
              key={notice.childSessionId ?? notice.createdAt}
              notice={notice}
              liveState={child?.state}
              liveLabel={child?.taskLabel}
              liveAttention={child?.attention}
              liveApprovalCommand={child?.approvalCommand ?? null}
              liveStartedAt={child?.startedAt ?? null}
              onOpen={child ? onOpen : undefined}
              onStop={child ? onStop : undefined}
              onDismiss={onDismiss}
              onLoadSessionEvents={child ? onLoadSessionEvents : undefined}
            />
          );
        })}
      </ul>
    </section>
  );
}
