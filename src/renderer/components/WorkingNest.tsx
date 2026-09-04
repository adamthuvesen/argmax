import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { stableHash32 } from "../lib/stableHash.js";

export const WORKING_NEST_CYCLE_MS = 900;
/** How long the landing runs — gather, pulse, open back out. Exported because a
 *  caller that swaps the nest for a finished mark has to hold the nest mounted
 *  this long, or the landing is replaced before it plays. */
export const WORKING_NEST_SETTLE_MS = 220;

/**
 * The working nest: four dots in a 2x2 where emphasis passes clockwise from
 * one leader to the next, so the cluster reads as rearranging rather than blinking.
 *
 * One mark for every "this is running right now" surface: a session row in the
 * sidebar, a sub-agent launch in the transcript, an agent tab, an agent pane
 * header. Live work looks the same wherever the user is looking. `active`
 * drives both the accent color and the motion. A settled nest rests still and
 * muted, and gets there through a landing: on the running → finished edge the
 * four dots gather into one, pulse in the leader's color, and open back out.
 * A caller that swaps the nest for a finished mark has to keep it mounted for
 * `WORKING_NEST_SETTLE_MS` first (hooks/useSettleHold.ts) or the landing is
 * unmounted before it plays. The sequence lives in CSS (.working-nest-dot) so
 * prefers-reduced-motion can pin it to a still nest. `phaseKey` keeps the same
 * job synchronized across surfaces while separate jobs start on different beats.
 */
export function WorkingNest({
  active,
  size = 14,
  className,
  phaseKey
}: {
  active: boolean;
  size?: number;
  className?: string;
  phaseKey?: string | undefined;
}): JSX.Element {
  const classes = ["working-nest", className].filter(Boolean).join(" ");
  const phase = phaseKey ? stableHash32(phaseKey) % 4 : 0;
  const nestRef = useRef<SVGSVGElement>(null);
  const wasActiveRef = useRef(active);
  const [isSettling, setIsSettling] = useState(false);

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active) setIsSettling(false);
    else if (wasActive) setIsSettling(true);
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;

    for (const dot of nestRef.current?.querySelectorAll(".working-nest-dot") ?? []) {
      for (const animation of dot.getAnimations?.() ?? []) {
        // CSS delays are normally relative to mount time. Anchoring every relay
        // to the document timeline keeps duplicate markers on the same beat.
        animation.startTime = 0;
      }
    }
  }, [active]);

  useEffect(() => {
    if (!isSettling) return;
    const timeoutId = window.setTimeout(() => setIsSettling(false), WORKING_NEST_SETTLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isSettling]);

  return (
    <svg
      ref={nestRef}
      className={classes}
      data-active={active ? "true" : undefined}
      data-settling={isSettling ? "true" : undefined}
      data-working={active ? "true" : undefined}
      data-phase={phase}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="currentColor"
      style={{
        "--working-nest-phase": phase,
        "--working-nest-settle-duration": `${WORKING_NEST_SETTLE_MS}ms`
      } as CSSProperties}
      aria-hidden="true"
    >
      <circle className="working-nest-dot" data-dot="1" cx="4.2" cy="4.2" r="2.2" />
      <circle className="working-nest-dot" data-dot="2" cx="9.8" cy="4.2" r="2.2" />
      <circle className="working-nest-dot" data-dot="3" cx="9.8" cy="9.8" r="2.2" />
      <circle className="working-nest-dot" data-dot="4" cx="4.2" cy="9.8" r="2.2" />
    </svg>
  );
}
