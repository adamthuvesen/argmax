import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { prefersReducedMotion, splitAtChange } from "../lib/routeSwitch.js";

export interface TextRoll {
  /** Keys the roll: a new id rolls again. */
  id: number;
  from: string;
  direction: "up" | "down";
  /** How far into the roll this mount starts, for a label remounted mid-roll. */
  elapsedMs: number;
  /** Wait before rolling, to follow a neighbouring label's roll. */
  delayMs: number;
  durationMs: number;
}

// The curve the rolling words use (--route-switch-ease in chat-chrome.css),
// so the width arrives with the words rather than ahead of them.
const ROLL_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * A label that rolls to its new text once per `roll`: the old words leave
 * upward and the new ones rise in for a step up, the reverse for a step down,
 * while the width eases between the two. Plain text before and after, so the
 * label's ellipsis still applies at rest.
 */
export function RollingText({ text, roll }: { text: string; roll?: TextRoll | null }): JSX.Element {
  const [finishedId, setFinishedId] = useState<number | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const outRef = useRef<HTMLSpanElement | null>(null);
  const inRef = useRef<HTMLSpanElement | null>(null);
  const rolling =
    roll &&
    roll.id !== finishedId &&
    roll.from !== text &&
    roll.elapsedMs < roll.durationMs + roll.delayMs &&
    !prefersReducedMotion()
      ? roll
      : null;
  const rollingRef = useRef(rolling);
  rollingRef.current = rolling;
  const rollingId = rolling?.id ?? null;

  // The words sit side by side in flow, so the width can't transition on its
  // own: ease it from the leaving words' width to the arriving ones'.
  useLayoutEffect(() => {
    const current = rollingRef.current;
    const box = boxRef.current;
    const leaving = outRef.current;
    const arriving = inRef.current;
    if (!current || !box || !leaving || !arriving || typeof box.animate !== "function") return undefined;
    // Fractional widths: offsetWidth rounds, and the box would end the roll
    // up to half a pixel off the plain text that replaces it, then snap.
    const animation = box.animate(
      [
        { width: `${leaving.getBoundingClientRect().width}px` },
        { width: `${arriving.getBoundingClientRect().width}px` }
      ],
      { duration: current.durationMs, delay: current.delayMs, easing: ROLL_EASING, fill: "backwards" }
    );
    animation.currentTime = current.elapsedMs;
    return () => animation.cancel();
  }, [rollingId]);

  if (!rolling) return <>{text}</>;
  const [prefix, fromRest, toRest] = splitAtChange(rolling.from, text);
  const timing = {
    animationDelay: `${rolling.delayMs - rolling.elapsedMs}ms`,
    animationDuration: `${rolling.durationMs}ms`
  };
  return (
    <>
      {prefix}
      <span ref={boxRef} className="rolling-text" data-direction={rolling.direction}>
        {/* The leaving words are painted from the attribute, not the DOM, so
            the label's text is the new label alone throughout the roll. */}
        <span ref={outRef} className="rolling-text-out" aria-hidden="true" data-text={fromRest} style={timing} />
        <span
          ref={inRef}
          className="rolling-text-in"
          style={timing}
          onAnimationEnd={() => setFinishedId(rolling.id)}
        >
          {toRest}
        </span>
      </span>
    </>
  );
}
