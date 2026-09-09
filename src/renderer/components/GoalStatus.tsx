import "../styles/goals.css";
import { useCallback, useEffect, useState, type JSX } from "react";
import { Target, X } from "lucide-react";
import type { Goal, SessionSummary } from "../../shared/types.js";

/** Sentence for the state the goal settled in. */
const OUTCOME_LABELS: Record<string, string> = {
  achieved: "Goal met",
  impossible: "Goal can't be met",
  stopped: "Goal stopped"
};

/**
 * The active goal for a session, and the control to end it.
 *
 * A goal is one condition plus a verdict, so there is nothing to configure
 * here and no form to open — `/goal <condition>` in the composer sets it. This
 * reports the condition the session is working toward.
 *
 * A settled goal stays on screen until dismissed. Letting the strip vanish the
 * moment a goal is met would make the ending the one part of the run nobody
 * sees.
 */
export function GoalStatus({ session }: { session: SessionSummary }): JSX.Element | null {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.argmax?.goals;
    if (!api) return;
    try {
      setGoal(await api.get({ sessionId: session.id }));
    } catch {
      // A goal that cannot be read is not worth an error in the lane; the next
      // delta re-reads it.
    }
  }, [session.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const dashboard = window.argmax?.dashboard;
    if (!dashboard) return;
    return dashboard.onDelta((delta) => {
      if (delta.resyncRequired || delta.goalChangedIds?.length || delta.changedSessionIds?.includes(session.id)) {
        void refresh();
      }
    });
  }, [refresh, session.id]);

  if (!goal || goal.id === dismissed) return null;

  const active = goal.state === "active";
  const clear = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (active) await window.argmax!.goals.clear({ sessionId: session.id });
      setDismissed(goal.id);
      setGoal(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not clear the goal.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="composer-queued-lane goal-status" data-state={goal.state} aria-label="Goal">
      <div className="composer-queued-chip goal-status-row">
        <button
          type="button"
          className="goal-status-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? "Collapse goal details" : goal.condition}
        >
          <Target size={14} className="composer-queued-chip-icon" aria-hidden="true" />
          <span className="goal-status-label">{active ? "Goal" : OUTCOME_LABELS[goal.state] ?? "Goal"}</span>
          <span className="goal-status-condition">{goal.condition}</span>
        </button>
        <button
          type="button"
          className="composer-queued-chip-remove"
          aria-label={active ? "Clear goal" : "Dismiss goal"}
          title={active ? "Clear goal" : "Dismiss goal"}
          disabled={pending}
          onClick={() => void clear()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p className="goal-status-error" role="alert">{error}</p>}
    </section>
  );
}
