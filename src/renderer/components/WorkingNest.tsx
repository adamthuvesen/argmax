import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  ACTIVITY_MARK_PART_COUNT,
  useActivityMark,
  type ActivityMarkId
} from "../lib/activityMark.js";
import { stableHash32 } from "../lib/stableHash.js";

/** How long the landing runs — gather, pulse, open back out. Exported because a
 *  caller that swaps the nest for a finished mark has to hold the nest mounted
 *  this long, or the landing is replaced before it plays. */
export const WORKING_NEST_SETTLE_MS = 220;

/**
 * The working nest: the app's single "this is running right now" mark.
 *
 * One mark for every such surface — a session row in the sidebar, a sub-agent
 * launch in the transcript, an agent tab, an agent pane header. Live work looks
 * the same wherever the user is looking. `active` drives both the accent colour
 * and the motion. A settled mark rests still and muted, and gets there through
 * a landing: on the running → finished edge it gathers, pulses in the leader's
 * colour, and opens back out. A caller that swaps the mark for a finished glyph
 * has to keep it mounted for `WORKING_NEST_SETTLE_MS` first
 * (hooks/useSettleHold.ts) or the landing is unmounted before it plays.
 *
 * Which shape it takes is Settings → Appearance → Activity mark
 * (`lib/activityMark.ts`): four dots relaying round a 2x2 (`nest`), a wave down
 * a 3x3 field (`cascade`), three bars on unrelated periods (`meter`), or a
 * comet on a track (`orbit`). Every style is the same box, the same colours and
 * the same settle; only the parts inside differ, so the sequences all live in
 * CSS (`styles/working-nest.css`) and `prefers-reduced-motion` can pin any of
 * them to a still frame. `phaseKey` keeps the same job synchronised across
 * surfaces while separate jobs start on different beats.
 *
 * `still` asks for that pinned frame on purpose: the live accent, none of the
 * motion. It is for a surface where the mark is a header identity rather than a
 * status ticker, and a relay beside a title would only be noise.
 *
 * Drawn with HTML elements rather than SVG on purpose. WebKit's legacy SVG
 * renderer has no accelerated compositing at all — the layer tree does not know
 * SVG exists — so an SVG `<circle>` animating `transform` repaints every frame
 * exactly like animating `fill` does. The same shapes as absolutely-positioned
 * boxes animating only `transform` and `opacity` run on the compositor, which
 * is what makes it affordable to have thirty of these on screen at once.
 */
export function WorkingNest({
  active,
  size = 14,
  className,
  phaseKey,
  still = false,
  markId: markIdOverride
}: {
  active: boolean;
  size?: number;
  className?: string;
  phaseKey?: string | undefined;
  still?: boolean;
  /** Force one style regardless of the setting. Only the settings picker wants
   *  this — it has to show all four at once. */
  markId?: ActivityMarkId;
}): JSX.Element {
  // Subscribe unconditionally — `??` would short-circuit the hook away whenever
  // the picker passes an override.
  const chosenMarkId = useActivityMark();
  const markId = markIdOverride ?? chosenMarkId;
  const classes = ["working-nest", className].filter(Boolean).join(" ");
  const phase = phaseKey ? stableHash32(phaseKey) % 4 : 0;
  const nestRef = useRef<HTMLSpanElement>(null);
  const wasActiveRef = useRef(active);
  const [isSettling, setIsSettling] = useState(false);

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active) setIsSettling(false);
    else if (wasActive) setIsSettling(true);
  }, [active]);

  useLayoutEffect(() => {
    if (!active || still) return;

    for (const part of nestRef.current?.querySelectorAll(".working-nest-part") ?? []) {
      for (const animation of part.getAnimations?.() ?? []) {
        // CSS delays are normally relative to mount time. Anchoring every part
        // to the document timeline keeps duplicate marks on the same beat.
        animation.startTime = 0;
      }
    }
    // `markId` is a dependency because switching styles swaps the parts out for
    // a different set, and the new ones mount with fresh mount-relative delays.
  }, [active, still, markId]);

  useEffect(() => {
    if (!isSettling) return;
    const timeoutId = window.setTimeout(() => setIsSettling(false), WORKING_NEST_SETTLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isSettling]);

  return (
    <span
      ref={nestRef}
      className={classes}
      data-mark={markId}
      data-active={active ? "true" : undefined}
      data-settling={isSettling ? "true" : undefined}
      data-still={still ? "true" : undefined}
      data-working={active ? "true" : undefined}
      data-phase={phase}
      style={{
        // Not `width`/`height`: a stylesheet has to be able to resize the mark
        // (see `--working-nest-size-override` in styles/working-nest.css), and
        // an inline dimension would outrank every rule that tried.
        "--working-nest-size": `${size}px`,
        "--working-nest-phase": phase,
        "--working-nest-settle-duration": `${WORKING_NEST_SETTLE_MS}ms`
      } as CSSProperties}
      aria-hidden="true"
    >
      {markParts(markId)}
    </span>
  );
}

/**
 * The moving pieces for one style. Every animated element carries
 * `working-nest-part` so the timeline anchoring above finds it whatever the
 * style is, and `data-dot` so the stylesheet can address them individually.
 *
 * Orbit is the odd one: a single rotating group carries five static dots at
 * fixed angles, so the whole comet and its trail cost one animation. The trail
 * dots are not parts — they never animate.
 */
function markParts(markId: ActivityMarkId): JSX.Element[] {
  if (markId === "orbit") {
    return [
      <i className="working-nest-part" data-dot={1} key="ring">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} style={{ "--working-nest-trail": i } as CSSProperties} />
        ))}
      </i>
    ];
  }
  return Array.from({ length: ACTIVITY_MARK_PART_COUNT[markId] }, (_, index) => (
    <i className="working-nest-part" data-dot={index + 1} key={index} />
  ));
}
