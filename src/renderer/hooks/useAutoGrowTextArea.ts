import { useLayoutEffect, type RefObject } from "react";

// Native content sizing needs no per-keystroke JS. The JS fallback below
// mutates the focused textarea's height (collapse to "auto", measure, restore)
// on every input — on iOS Safari that geometry change makes WebKit re-run its
// caret-reveal viewport pan each keystroke, visibly bouncing the chat behind
// the keyboard. Prefer the CSS engine wherever it exists.
const supportsFieldSizing =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

function computedMinHeight(el: HTMLTextAreaElement): number {
  const minHeight = Number.parseFloat(window.getComputedStyle(el).minHeight);
  return Number.isFinite(minHeight) ? minHeight : 0;
}

function syncTextAreaHeight(el: HTMLTextAreaElement, maxHeightPx: number): void {
  el.style.height = "auto";
  const contentHeight = el.scrollHeight;
  const next = Math.max(computedMinHeight(el), Math.min(contentHeight, maxHeightPx));
  el.style.height = `${next}px`;
  el.style.overflowY = contentHeight > maxHeightPx ? "auto" : "hidden";
}

export function useAutoGrowTextArea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightPx: number
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !supportsFieldSizing) return;
    el.style.setProperty("field-sizing", "content");
    el.style.maxHeight = `${maxHeightPx}px`;
    el.style.overflowY = "auto";
  }, [ref, maxHeightPx]);

  // Fallback sizing for engines without field-sizing. The observer lives as
  // long as the element (not per keystroke — a fresh observe() fires an
  // initial callback, doubling the height mutations per input).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || supportsFieldSizing) return;
    const sync = (): void => syncTextAreaHeight(el, maxHeightPx);
    sync();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(sync);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [ref, maxHeightPx]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || supportsFieldSizing) return;
    syncTextAreaHeight(el, maxHeightPx);
  }, [ref, value, maxHeightPx]);
}
