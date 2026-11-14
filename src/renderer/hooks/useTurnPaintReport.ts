import { useEffect, useMemo } from "react";
import type { TimelineEvent } from "../../shared/types.js";

// Turns already reported from this window. Two panes on one chat report once.
const reportedTurns = new Set<string>();
const REPORTED_TURNS_CAP = 500;

// The same rows `providers::turn_waterfall::is_turn_content` counts: assistant
// text and a tool start, not a raw stdout echo.
function isTurnContent(event: TimelineEvent): boolean {
  if (
    event.type !== "message.delta" &&
    event.type !== "message.completed" &&
    event.type !== "command.started"
  ) {
    return false;
  }
  const payload = event.payload;
  const stream =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload.stream : undefined;
  return stream !== "stdout" && stream !== "stderr" && stream !== "pty";
}

/** The `user.message` id of the newest turn once it has content, else null.
 *  Dashboard events arrive newest-first. */
function answeredTurnKey(events: readonly TimelineEvent[]): string | null {
  let hasContent = false;
  for (const event of events) {
    if (event.type === "user.message") return hasContent ? event.id : null;
    if (isTurnContent(event)) hasContent = true;
  }
  return null;
}

/**
 * Reports the first painted answer of the session's newest turn to the turn
 * waterfall (`session:turn-painted`). "Painted" is two animation frames after
 * the commit that rendered it. The backend ignores a report for a turn it is
 * not timing, so opening an old chat costs one ignored call.
 */
export function useTurnPaintReport(
  sessionId: string | null,
  events: readonly TimelineEvent[],
): void {
  const turnKey = useMemo(() => answeredTurnKey(events), [events]);
  useEffect(() => {
    if (!sessionId || !turnKey || reportedTurns.has(turnKey)) return undefined;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (reportedTurns.has(turnKey)) return;
        if (reportedTurns.size >= REPORTED_TURNS_CAP) reportedTurns.clear();
        reportedTurns.add(turnKey);
        void window.argmax?.session
          ?.turnPainted({ sessionId, turnKey, paintedAtMs: Date.now() })
          .catch(() => undefined);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [sessionId, turnKey]);
}
