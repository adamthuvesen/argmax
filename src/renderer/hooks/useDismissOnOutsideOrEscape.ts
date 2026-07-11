import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DismissOptions {
  /**
   * Trap Tab/Shift+Tab inside `ref` so focus cycles within the dismissable
   * surface instead of escaping to background controls. Use only for true
   * modal dialogs (CommandPalette, SearchOverlay, KeyboardCheatSheet,
   * WorkspaceContentSearchOverlay) — popovers like the IDE
   * picker and project picker do not need a trap.
   */
  trapFocus?: boolean;
}

export function useDismissOnOutsideOrEscape(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  close: () => void,
  extraRef?: RefObject<HTMLElement | null>,
  options: DismissOptions = {}
): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  const { trapFocus = false } = options;

  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const insideMain = ref.current?.contains(target) ?? false;
      const insideExtra = extraRef?.current?.contains(target) ?? false;
      if (!insideMain && !insideExtra) {
        closeRef.current();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!trapFocus || event.key !== "Tab") return;
      const container = ref.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => !el.hasAttribute("inert"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      const insideContainer = active ? container.contains(active) : false;
      if (event.shiftKey) {
        if (!insideContainer || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (!insideContainer || active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, { capture: true });
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [active, ref, extraRef, trapFocus]);
}
