import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";

const DISMISS_DISTANCE_PX = 72;
/** Backstop for the ride out, in case `transitionend` never lands (the sheet
 *  scrolled out of a compositor's way, a suspended tab). Longer than
 *  `--duration-base` so it never cuts the real transition short. */
const EXIT_TIMEOUT_MS = 400;
/** How long the rise waits for a native composer to leave the floor before
 *  going anyway. The card is removed without animation, so one or two frames
 *  is the honest wait; the cap only matters if the host never answers. */
const FLOOR_WAIT_MS = 250;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * A subagent or multitask peek, raised over the transcript as a bottom sheet.
 *
 * It rises from the bottom edge and covers the parent's composer and its
 * multitask lane. An earlier pass stopped it above them — measuring the
 * floor's furniture and holding that many pixels clear — so a reply to the
 * parent was one tap away while the peek was up. On a phone that read as two
 * composers stacked, and the sheet was the only thing on the screen that did
 * not come all the way up. Reading delegated work and replying to the chat
 * that spawned it are two acts, and the second one waits for the sheet to
 * close: the parent's composer comes back the moment it does.
 *
 * Still not a full screen. The transcript stays visible above, which is what
 * says the peek belongs to the chat behind it rather than being a place you
 * navigated to.
 *
 * Presentation is controlled: `open` is the reader's intent and the parent
 * keeps this mounted until `onExited`. That split is what lets the phone's
 * native composer come back at the *start* of the ride out — it rises behind
 * a sheet that is still on screen, instead of the floor being empty for the
 * length of the animation plus a bridge round trip.
 */
export function AgentOverlay({
  label,
  open,
  awaitsFloorChange = false,
  onClose,
  onExited,
  children
}: {
  label: string;
  /** Whether the sheet should be up. False starts the ride out; the parent
   *  unmounts on `onExited`. */
  open: boolean;
  /** Whether a native card has to leave the floor before the sheet rises.
   *  True in the phone's native shell, where dropping the composer resizes
   *  the web view: rising into that resize re-lays the sheet out mid-flight. */
  awaitsFloorChange?: boolean;
  /** Dismissal intent — scrim, Escape, the close button, a swipe down. */
  onClose: () => void;
  /** The sheet is off the screen and can be unmounted. */
  onExited: () => void;
  children: ReactNode;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Mounted below the edge, then raised on a later frame: a transition needs
  // the starting transform painted once, and the wait doubles as the floor's.
  const [raised, setRaised] = useState(false);
  const dragOriginY = useRef<number | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // iOS does not move focus when a row is tapped, so a raised keyboard from
  // the parent composer would still be up and squeeze this peek to a sliver.
  // Blur it on open; the composer stays tappable underneath.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const host = hostRef.current;
    if (focused instanceof HTMLElement && !host?.contains(focused)) focused.blur();
  }, []);

  useEffect(() => {
    if (!open || raised) return undefined;
    const startHeight = viewportHeight();
    const deadline = performance.now() + FLOOR_WAIT_MS;
    let frame = requestAnimationFrame(function tick(): void {
      const floorCleared = !awaitsFloorChange || viewportHeight() !== startHeight;
      if (floorCleared || performance.now() >= deadline) {
        setRaised(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [awaitsFloorChange, open, raised]);

  // The ride out ends on the transition, not on a timer racing the CSS: the
  // two used to be written down separately and disagreed by 40ms.
  useEffect(() => {
    if (open) return undefined;
    const finish = (): void => onExitedRef.current();
    if (prefersReducedMotion()) {
      finish();
      return undefined;
    }
    const panel = panelRef.current;
    const timer = window.setTimeout(finish, EXIT_TIMEOUT_MS);
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target !== panel || event.propertyName !== "transform") return;
      window.clearTimeout(timer);
      finish();
    };
    panel?.addEventListener("transitionend", onTransitionEnd);
    return () => {
      window.clearTimeout(timer);
      panel?.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [open]);

  const requestClose = useCallback((): void => {
    if (!open) return;
    onClose();
  }, [onClose, open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const onGripPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !open) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    dragOriginY.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onGripPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragOriginY.current === null) return;
    setDragY(Math.max(0, event.clientY - dragOriginY.current));
  };

  // Dropping the inline offset hands the sheet back to CSS: on a dismissal it
  // carries on down from where the thumb left it, and on a short drag it
  // settles back up. It used to jump to the top first and then fade out 16px,
  // which read as the sheet refusing the gesture it had just accepted.
  const onGripPointerUp = (): void => {
    const distance = dragY;
    dragOriginY.current = null;
    setDragging(false);
    setDragY(0);
    if (distance >= DISMISS_DISTANCE_PX) requestClose();
  };

  return (
    <div className="mobile-agent-overlay" ref={hostRef} data-raised={(open && raised) || undefined}>
      <div className="mobile-agent-overlay-scrim" role="presentation" onClick={requestClose} />
      <div
        className="mobile-agent-overlay-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        data-dragging={dragging || undefined}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          className="mobile-agent-overlay-grip"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
        >
          <span className="mobile-sheet-grabber" aria-hidden="true" />
          <button
            type="button"
            className="mobile-agent-overlay-close"
            aria-label={`Close ${label}`}
            onClick={requestClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="mobile-agent-overlay-body">{children}</div>
      </div>
    </div>
  );
}
