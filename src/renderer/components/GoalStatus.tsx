import "../styles/session-panels.css";
import "../styles/goals.css";
import { useCallback, useEffect, useState, type JSX } from "react";
import { Target } from "lucide-react";
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
 * only reports: what the session is working toward, how far into its turn
 * budget it is, and what the evaluator last said.
 *
 * A settled goal stays on screen until dismissed. Letting the strip vanish the
 * moment a goal is met would make the ending the one part of the run nobody
 * sees.
 */
export function GoalStatus({ session }: { session: SessionSummary }): JSX.Element | null {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
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
    <section className="session-panel goal-status" data-state={goal.state} aria-label="Goal">
      <div className="goal-status-head">
        {active
          ? <span className="session-panel-dot" aria-hidden="true" />
          : <Target size={13} className="goal-status-mark" aria-hidden="true" />}
        <span className="session-panel-title">{active ? "Goal" : OUTCOME_LABELS[goal.state] ?? "Goal"}</span>
        {active && <span className="session-panel-note">turn {goal.turns} of {goal.maxTurns}</span>}
        <button type="button" className="session-panel-button session-panel-button-quiet" disabled={pending} onClick={() => void clear()}>
          {active ? "Clear" : "Dismiss"}
        </button>
      </div>
      <p className="goal-status-condition">{goal.condition}</p>
      {goal.lastReason && <p className="session-panel-hint">{goal.lastReason}</p>}
      {error && <p className="session-panel-error" role="alert">{error}</p>}
    </section>
  );
}
