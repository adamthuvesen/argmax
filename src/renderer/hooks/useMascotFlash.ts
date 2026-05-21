import { useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "../../shared/types.js";

const HAPPY_FLASH_MS = 1500;
const BOB_MS = 320;

/**
 * Mascot animation state — kept off the render path so re-renders don't
 * retrigger the flash. Two independent moments:
 *
 * - **Happy flash**: pops to "happy" for ~1.5 s after a new
 *   `message.completed` is observed. `lastCompletedIdRef` gates duplicate
 *   fires across re-renders; the very first observation per session is
 *   skipped so opening a long-completed session doesn't stale-pop.
 * - **Submit bob**: short bob (~320 ms) right after the user submits. The
 *   mascot's own click handler already animates a "pet"; this mirrors that
 *   onto the wrapper for keyboard submissions.
 *
 * Both states resolve via wall-clock comparisons so the consumer can stay
 * pure: `isHappyFlashing = happyFlashUntilMs > Date.now()`,
 * `isBobbing = justSentAt > 0 && Date.now() - justSentAt < 320`.
 */
export function useMascotFlash(
  sessionId: string | null,
  events: readonly TimelineEvent[]
): {
  happyFlashUntilMs: number;
  justSentAt: number;
  markSent: () => void;
} {
  const [happyFlashUntilMs, setHappyFlashUntilMs] = useState(0);
  const [justSentAt, setJustSentAt] = useState(0);
  const lastCompletedIdRef = useRef<string | null>(null);

  // Watch for the newest message.completed event; when it changes, flash
  // happy for HAPPY_FLASH_MS. Skip the very first observation per session
  // so we don't pop on a stale completion when opening an old session.
  useEffect(() => {
    const latest = events.find((e) => e.type === "message.completed");
    if (!latest) return;
    if (lastCompletedIdRef.current === latest.id) return;
    const prev = lastCompletedIdRef.current;
    lastCompletedIdRef.current = latest.id;
    if (prev === null) return;
    setHappyFlashUntilMs(Date.now() + HAPPY_FLASH_MS);
  }, [events]);

  // Schedule the falling edge so the next render reads happyFlashUntilMs
  // as 0 and the consumer's `> Date.now()` check resolves cleanly.
  useEffect(() => {
    if (happyFlashUntilMs === 0) return;
    const remaining = happyFlashUntilMs - Date.now();
    if (remaining <= 0) {
      setHappyFlashUntilMs(0);
      return;
    }
    const id = setTimeout(() => setHappyFlashUntilMs(0), remaining);
    return () => clearTimeout(id);
  }, [happyFlashUntilMs]);

  // Reset on session change so the new session can fire its own first flash.
  useEffect(() => {
    setHappyFlashUntilMs(0);
    setJustSentAt(0);
    lastCompletedIdRef.current = null;
  }, [sessionId]);

  return {
    happyFlashUntilMs,
    justSentAt,
    markSent: () => setJustSentAt(Date.now())
  };
}

export const MASCOT_BOB_MS = BOB_MS;
