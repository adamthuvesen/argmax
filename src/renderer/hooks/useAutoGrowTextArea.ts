import { useLayoutEffect, type RefObject } from "react";

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
    if (!el) return;
    const sync = (): void => syncTextAreaHeight(el, maxHeightPx);
    sync();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(sync);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [ref, value, maxHeightPx]);
}
