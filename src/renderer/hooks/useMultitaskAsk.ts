import { useEffect, useMemo } from "react";

import { multitaskPendingQuestion } from "../lib/multitaskAsk.js";
import { useSessionTimeline } from "./useSessionTimeline.js";

/**
 * The question a multitask is stopped on, read from its own transcript, for the
 * row in the chat that dispatched it. Subscribing keeps the child's timeline
 * resident and the load fills it: a dashboard hint only catches up sessions
 * that are already subscribed, and a chat waiting on a person changes nothing
 * until they answer. Off (`wanted` false) the hook subscribes to nothing, so a
 * running or finished row costs no transcript.
 */
export function useMultitaskAsk(
  sessionId: string | null,
  wanted: boolean,
  onLoadSessionEvents?: (sessionId: string) => Promise<void>
): string | null {
  const watched = wanted ? sessionId : null;
  const { events } = useSessionTimeline(watched);
  useEffect(() => {
    if (!watched || !onLoadSessionEvents) return;
    // A failed load leaves the row on its state word; the dock still opens it.
    void onLoadSessionEvents(watched).catch(() => undefined);
  }, [watched, onLoadSessionEvents]);
  return useMemo(() => (watched ? multitaskPendingQuestion(events) : null), [events, watched]);
}
