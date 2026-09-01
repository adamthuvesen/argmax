import { useEffect } from "react";

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
export function useVisualViewportInsets(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;

    const apply = (): void => {
      frame = 0;
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
  }, []);
}
