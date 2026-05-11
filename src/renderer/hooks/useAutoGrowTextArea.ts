import { useEffect, type RefObject } from "react";

export function useAutoGrowTextArea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightPx: number
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeightPx ? "auto" : "hidden";
  }, [ref, value, maxHeightPx]);
}
