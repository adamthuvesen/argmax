import { useEffect, useState } from "react";

// Longer than the slowest entrance animation in a transcript (.chat-bubble,
// 240ms), so those animations have already finished by the time the flag
// clears and none of them plays a second time.
const RESTORE_MS = 320;

/**
 * True for the first moments after a pane mounts, while it paints content that
 * was already there.
 *
 * Switching sessions remounts the pane because the grid keys its cells by session id,
 * so every restored bubble and tool row would otherwise replay its entrance
 * animation and the whole transcript would visibly slide each time a session is
 * reopened. Panes hang this on their scroller as `data-restoring`; the CSS side
 * of the contract lives in chat-conversation.css. StreamingMarkdown takes the
 * same flag so completed bubbles in a still-running turn paint in full instead
 * of typing out from nothing together.
 *
 * `hydrated` is what the window is measured from. A pane mounts before its
 * transcript exists: an unselected session is unsubscribed and receives no
 * events at all, so reopening one backfills the whole backlog over as many
 * `eventsSince` round trips as it takes (raw output pages hold 100 rows, and a
 * live Claude turn writes a couple of hundred a minute). Timing the window from
 * mount let that backfill land after the flag had already cleared, and every
 * restored bubble then animated and typed itself out as if it had just arrived.
 * Callers that have no backfill to wait for leave it at the default.
 */
export function useRestoreWithoutMotion(hydrated = true): boolean {
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    if (!hydrated) {
      // A later pane (or a session switch) restarts the wait rather than
      // leaving a stale `false` over content that has not arrived yet.
      setRestoring(true);
      return;
    }
    const id = window.setTimeout(() => setRestoring(false), RESTORE_MS);
    return () => window.clearTimeout(id);
  }, [hydrated]);
  return restoring;
}
