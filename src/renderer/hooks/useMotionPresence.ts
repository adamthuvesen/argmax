import { useCallback, useEffect, useState, type AnimationEvent } from "react";

export type MotionPresenceState = "open" | "closing";

const EXIT_TIMEOUT_MS = 320;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Keep a surface mounted while its CSS exit animation runs.
 *
 * `visible` remains the interaction state, so focus traps and outside-click
 * listeners stop as soon as dismissal is requested. `present` is only the
 * paint lifetime. The animation event is the normal completion path and the
 * timeout is a backstop for a suspended or removed animation timeline.
 */
export function useMotionPresence(visible: boolean): {
  present: boolean;
  motionState: MotionPresenceState;
  onMotionEnd: (event: AnimationEvent<HTMLElement>) => void;
} {
  const [present, setPresent] = useState(visible);
  const [previousVisible, setPreviousVisible] = useState(visible);

  if (visible !== previousVisible) {
    setPreviousVisible(visible);
    if (visible) setPresent(true);
  }

  useEffect(() => {
    if (visible || !present) return undefined;
    if (prefersReducedMotion()) {
      setPresent(false);
      return undefined;
    }
    const timeout = window.setTimeout(() => setPresent(false), EXIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [present, visible]);

  const onMotionEnd = useCallback(
    (event: AnimationEvent<HTMLElement>): void => {
      if (visible || event.target !== event.currentTarget) return;
      setPresent(false);
    },
    [visible]
  );

  return {
    present,
    motionState: visible ? "open" : "closing",
    onMotionEnd
  };
}
