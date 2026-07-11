import { useEffect, useRef } from "react";

/**
 * Restore focus to the element that was active when `open` became true.
 * Used by modal overlays such as search, the cheat sheet, and commit dialog.
 */
export function useRestoreFocus(open: boolean): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previous && document.contains(previous)) {
      previous.focus();
    }
  }, [open]);
}
