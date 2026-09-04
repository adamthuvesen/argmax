import { useEffect, useRef, useState } from "react";

const DEFAULT_DURATION_MS = 600;

function readPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Ticks a number toward its target instead of jumping, Codex-style: file
 * counts climb while the agent works rather than swapping mid-glance.
 *
 * Mounts at the target (no entrance animation — a freshly opened panel is
 * already showing settled state) and eases between values on updates with
 * an ease-out cubic over `durationMs`. Reduced-motion users and environments
 * without rAF jump straight to the target. Restarts from the currently
 * displayed value when the target moves mid-flight, and always lands
 * exactly on it.
 */
export function useAnimatedNumber(target: number, durationMs: number = DEFAULT_DURATION_MS): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef(0);

  useEffect(() => {
    if (displayRef.current === target) return;
    if (
      readPrefersReducedMotion() ||
      typeof requestAnimationFrame !== "function" ||
      typeof cancelAnimationFrame !== "function"
    ) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = displayRef.current;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (target - from) * eased);
      displayRef.current = value;
      setDisplay(value);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs]);

  return display;
}
