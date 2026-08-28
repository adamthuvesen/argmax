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
 * of the contract lives in chat-conversation.css.
 */
export function useRestoreWithoutMotion(): boolean {
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setRestoring(false), RESTORE_MS);
    return () => window.clearTimeout(id);
  }, []);
  return restoring;
}
