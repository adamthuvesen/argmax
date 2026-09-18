import { useLayoutEffect, type RefObject } from "react";

// Numbers shared with the iPhone (ios/Argmax/Sources/Design/ReadingWave.swift);
// styles/reading-wave.css owns the band's width and colours.
//
// A fixed pixel speed and a fixed cadence are mutually exclusive: at one
// speed, a short word finishes (and repeats) far more often per second than a
// long sentence does, so it *reads* faster even though the band moves at the
// same rate. Holding the pass *time* constant instead — and letting the
// band's speed vary with the line's length — is what makes every line pulse
// at the same rhythm, whether it's one word or a full sentence.
/** A pass over the words takes exactly this long, whatever the line's length. */
const PASS_SECONDS = 1.1;
/** Half-width of the band in ems; must match `--reading-wave-sigma`. */
const SIGMA_EM = 1.1;
/** Pause between passes, in seconds. */
const PAUSE_SECONDS = 0.4;

/**
 * Sizes the reading wave on `container` while `active`: the band's travel is
 * the visible width of the `.reading-wave-text` spans inside it, and each span
 * learns where it starts so the pass runs through them as one line. `measureKey`
 * is whatever changes the line's text; a resize remeasures on its own.
 */
export function useReadingWave(
  container: RefObject<HTMLElement | null>,
  active: boolean,
  measureKey: string
): void {
  useLayoutEffect(() => {
    const node = container.current;
    if (!active || !node) return;

    const measure = (): void => {
      const spans = Array.from(node.querySelectorAll<HTMLElement>(".reading-wave-text"));
      const first = spans[0];
      if (!first) return;
      const start = first.getBoundingClientRect().left;
      let end = start;
      for (const span of spans) {
        const rect = span.getBoundingClientRect();
        span.style.setProperty("--reading-wave-offset", `${rect.left - start}px`);
        // A truncated line clips its spans; the band only needs to cross what shows.
        let visibleRight = rect.right;
        for (let clip = span.parentElement; clip && clip !== node.parentElement; clip = clip.parentElement) {
          if (getComputedStyle(clip).overflowX !== "visible") {
            visibleRight = Math.min(visibleRight, clip.getBoundingClientRect().right);
          }
        }
        end = Math.max(end, visibleRight);
      }
      const em = Number.parseFloat(getComputedStyle(node).fontSize) || 13;
      const sigma = SIGMA_EM * em;
      // The band enters 3σ before the first glyph and leaves 3σ after the last.
      const travel = end - start + 6 * sigma;
      const speed = travel / PASS_SECONDS;
      const cycle = travel + PAUSE_SECONDS * speed;
      const duration = PASS_SECONDS + PAUSE_SECONDS;
      if (Math.abs(Number.parseFloat(node.style.getPropertyValue("--reading-wave-cycle")) - cycle) < 0.5) {
        return;   // same geometry: leave the pass alone
      }

      // A longer line means a longer cycle, and re-timing the animation would
      // land the band somewhere else — a jump mid-pass. Carry the head over
      // instead: the band keeps its position and its speed across a wording
      // change, and only a fresh line takes its phase from the wall clock.
      // jsdom has no Web Animations, and neither has a line whose animation
      // has not started yet; both fall through to the wall-clock anchor.
      const animation = node.getAnimations?.().find(
        (candidate) => (candidate as CSSAnimation).animationName === "reading-wave"
      );
      const head = Number.parseFloat(getComputedStyle(node).getPropertyValue("--reading-wave-head"));
      node.style.setProperty("--reading-wave-cycle", `${cycle}px`);
      node.style.setProperty("--reading-wave-duration", `${duration}s`);
      node.style.setProperty("--reading-wave-delay", "0s");
      if (animation) {
        const into = Number.isFinite(head)
          ? (head + 3 * sigma) / speed
          : (Date.now() / 1000) % duration;
        animation.currentTime = into * 1000;
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [container, active, measureKey]);
}
