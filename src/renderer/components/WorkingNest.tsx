import type { JSX } from "react";

/**
 * The working nest: four dots in a 2x2 where each swells a quarter-cycle behind
 * the one before it, so the cluster reads as rearranging rather than blinking.
 *
 * One mark for every "this is running right now" surface: a session row in the
 * sidebar, a sub-agent launch in the transcript, an agent tab, an agent pane
 * header. Live work looks the same wherever the user is looking. `active`
 * drives both the accent color and the motion. A settled nest rests still and
 * muted. The sequence lives in CSS (.working-nest-dot) so
 * prefers-reduced-motion can pin it to a still nest.
 */
export function WorkingNest({
  active,
  size = 14,
  className
}: {
  active: boolean;
  size?: number;
  className?: string;
}): JSX.Element {
  const classes = ["working-nest", className].filter(Boolean).join(" ");

  return (
    <svg
      className={classes}
      data-active={active ? "true" : undefined}
      data-working={active ? "true" : undefined}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle className="working-nest-dot" data-dot="1" cx="4.6" cy="4.6" r="1.8" />
      <circle className="working-nest-dot" data-dot="2" cx="9.4" cy="4.6" r="1.8" />
      <circle className="working-nest-dot" data-dot="3" cx="9.4" cy="9.4" r="1.8" />
      <circle className="working-nest-dot" data-dot="4" cx="4.6" cy="9.4" r="1.8" />
    </svg>
  );
}
