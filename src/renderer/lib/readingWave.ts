import { useLayoutEffect, type RefObject } from "react";

// Numbers shared with the iPhone (ios/Argmax/Sources/Design/ReadingWave.swift);
// styles/reading-wave.css owns the band's width and colours.
/** Band travel speed in ems per second: constant, so a long line does not whip
 *  past and a short word does not crawl. */
const SPEED_EM_PER_SECOND = 7.15;
/** Half-width of the band in ems; must match `--reading-wave-sigma`. */
const SIGMA_EM = 1.1;
/** Pause between passes, in seconds. */
const PAUSE_SECONDS = 0.4;
/** Shortest cycle, so a one-word line never strobes. */
const MINIMUM_CYCLE_SECONDS = 1.6;

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
      const speed = SPEED_EM_PER_SECOND * em;
      const cycle = Math.max(
        end - start + 6 * SIGMA_EM * em + PAUSE_SECONDS * speed,
        MINIMUM_CYCLE_SECONDS * speed
      );
      const duration = cycle / speed;
      if (Math.abs(Number.parseFloat(node.style.getPropertyValue("--reading-wave-cycle")) - cycle) < 0.5) {
        return;   // same geometry: leave the pass alone
      }

      // A longer line means a longer cycle, and re-timing the animation would
      // land the band somewhere else — a jump mid-pass. Carry the head over
      // instead: the band keeps its position and its speed across a wording
      // change, and only a fresh line takes its phase from the wall clock.
      const animation = node.getAnimations().find(
        (candidate) => (candidate as CSSAnimation).animationName === "reading-wave"
      );
      const head = Number.parseFloat(getComputedStyle(node).getPropertyValue("--reading-wave-head"));
      node.style.setProperty("--reading-wave-cycle", `${cycle}px`);
      node.style.setProperty("--reading-wave-duration", `${duration}s`);
      node.style.setProperty("--reading-wave-delay", "0s");
      if (animation) {
        const sigma = SIGMA_EM * em;
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
