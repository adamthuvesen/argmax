import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DismissOptions {
  /**
   * Trap Tab/Shift+Tab inside `ref` so focus cycles within the dismissable
   * surface instead of escaping to background controls. Use only for true
   * modal dialogs (CommandPalette, KeyboardCheatSheet) — popovers like the IDE
   * picker and project picker do not need a trap.
   */
  trapFocus?: boolean;
}

interface EscapeDismissal {
  ref: RefObject<HTMLElement | null>;
  extraRef?: RefObject<HTMLElement | null>;
  order: number;
}

const escapeDismissals: EscapeDismissal[] = [];
let escapeDismissalOrder = 0;

function dismissalElements(dismissal: EscapeDismissal): HTMLElement[] {
  return [dismissal.ref.current, dismissal.extraRef?.current].filter(
    (element): element is HTMLElement => element !== null && element !== undefined
  );
}

function containsDismissal(outer: EscapeDismissal, inner: EscapeDismissal): boolean {
  const outerElements = dismissalElements(outer);
  const innerElements = dismissalElements(inner);
  return outerElements.some((outerElement) =>
    innerElements.some((innerElement) => outerElement !== innerElement && outerElement.contains(innerElement))
  );
}

function topEscapeDismissal(): EscapeDismissal | undefined {
  return escapeDismissals.reduce<EscapeDismissal | undefined>((top, candidate) => {
    if (!top) return candidate;
    if (containsDismissal(top, candidate)) return candidate;
    if (containsDismissal(candidate, top)) return top;
    return candidate.order > top.order ? candidate : top;
  }, undefined);
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
    const dismissal: EscapeDismissal = {
      ref,
      extraRef,
      order: ++escapeDismissalOrder
    };
    escapeDismissals.push(dismissal);
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const insideMain = ref.current?.contains(target) ?? false;
      const insideExtra = extraRef?.current?.contains(target) ?? false;
      if (!insideMain && !insideExtra) {
        closeRef.current();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.repeat &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (topEscapeDismissal() !== dismissal) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!trapFocus || event.key !== "Tab") return;
      const container = ref.current;
      if (!container) return;
      const containers = [container, extraRef?.current].filter(
        (candidate): candidate is HTMLElement => candidate !== null && candidate !== undefined
      );
      const focusable = containers.flatMap((candidate) =>
        Array.from(candidate.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      ).filter((el) => !el.hasAttribute("inert"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      const insideContainer = active ? containers.some((candidate) => candidate.contains(active)) : false;
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
      const dismissalIndex = escapeDismissals.indexOf(dismissal);
      if (dismissalIndex !== -1) escapeDismissals.splice(dismissalIndex, 1);
      document.removeEventListener("mousedown", handleMouseDown, { capture: true });
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [active, ref, extraRef, trapFocus]);
}
