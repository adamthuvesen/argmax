import { useEffect, type RefObject } from "react";

/** Bigger than the top inset the stuck-viewport bug eats, smaller than a rotation. */
const STUCK_VIEWPORT_MAX_PX = 80;

/**
 * Pin the phone shell to the *visual* viewport instead of the layout one.
 *
 * The shell is a fixed frame sized in `dvh`, and `dvh` ignores the on-screen
 * keyboard: iOS Safari keeps the layout viewport at full height and pans it
 * instead, so a raised keyboard hides the composer the reader is typing into
 * and the bottom sheet they just opened. Chrome answers this with
 * `interactive-widget=resizes-content` (mobile.html); iOS has no equivalent,
 * so the height and pan offset are read off `visualViewport` and published as
 * custom properties the stylesheet consumes.
 *
 * `--mobile-keyboard-inset` is the leftover strip of layout viewport below the
 * visual one — the keyboard's height in practice — for the few pieces of
 * chrome that stay anchored to the layout viewport, like the toast.
 *
 * Writes are batched into a frame because iOS fires `resize` and `scroll` on
 * every frame of the keyboard animation.
 */
export function useVisualViewportInsets(shellRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    // The bug below is a home-screen web app's. Safari also changes its
    // viewport height as the toolbar collapses and expands, and "restoring"
    // that would push the shell behind the toolbar.
    const standalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    let frame = 0;
    let tallestIdleHeight = window.innerHeight;
    let keyboardWasUp = false;

    /**
     * The first time the keyboard opens in an iOS home-screen web app,
     * `innerHeight`, `visualViewport.height` and `dvh` all shrink by the top
     * inset and never come back: the frame ends ~60px short of the screen and
     * a strip of bare background sits under the composer for the rest of the
     * session. Nothing can cover the strip — iOS clips fixed content to the
     * layout viewport — so the measurement itself has to be redone, which a
     * display flip with a synchronous reflow between the two writes forces.
     * Both writes land in one task, so the hidden frame is never painted.
     * https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d
     */
    const remeasureStuckViewport = (): void => {
      const keyboardDown = window.innerHeight - viewport.height - viewport.offsetTop <= 4;
      const justClosed = keyboardDown && keyboardWasUp;
      keyboardWasUp = !keyboardDown;
      if (!keyboardDown) return;
      const shortfall = tallestIdleHeight - window.innerHeight;
      // A height this different is the screen turning, not the bug.
      if (shortfall < 0 || shortfall > STUCK_VIEWPORT_MAX_PX) {
        tallestIdleHeight = window.innerHeight;
        return;
      }
      const shell = shellRef.current;
      if (!justClosed || shortfall <= 4 || !shell) return;
      shell.style.display = "none";
      void shell.offsetHeight;
      shell.style.display = "";
    };

    const apply = (): void => {
      frame = 0;
      if (standalone) remeasureStuckViewport();
      root.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--mobile-viewport-offset", `${viewport.offsetTop}px`);
      const keyboard = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty("--mobile-keyboard-inset", `${keyboard}px`);
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(apply);
    };

    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-offset");
      root.style.removeProperty("--mobile-keyboard-inset");
    };
  }, [shellRef]);
}
