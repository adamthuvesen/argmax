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
const CLOSE_MS = 180;

/**
 * A subagent or multitask peek, raised over the transcript.
 *
 * Deliberately not a full screen: the delegated work is something you glance at
 * and act on in the chat that spawned it, so the parent stays visible above and
 * its composer stays live below. The backdrop stops at the composer's top edge,
 * so a reply is one tap away without dismissing anything — on a phone that is
 * the difference between reading a result and answering it.
 */
export function AgentOverlay({
  label,
  onClose,
  children
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [composerInset, setComposerInset] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const dragOriginY = useRef<number | null>(null);
  const closeTimerRef = useRef<number>(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback((): void => {
    if (closing) return;
    setClosing(true);
    setDragging(false);
    setDragY(0);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), reduceMotion ? 0 : CLOSE_MS);
  }, [closing]);

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  // What the overlay clears is the gap from the column's floor up to the
  // composer's top edge, not the composer's own height: the chat screen holds
  // the home-indicator clearance under the composer, so reserving the height
  // alone lands the panel's edge that far inside the composer — invisible on a
  // desktop browser, a sliced composer on a phone. Queued follow-ups belong
  // above that edge too, so the whole stack is the landmark, and both it and
  // the column are watched: a follow-up being typed grows one, the keyboard
  // opening shrinks the other.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const column = host?.closest(".session-main-column");
    if (!(host instanceof HTMLElement) || !(column instanceof HTMLElement)) return;

    const parentComposer = (): HTMLElement | null => {
      const match = [...column.querySelectorAll(".session-composer-stack")].find(
        (candidate) => !host.contains(candidate)
      );
      return match instanceof HTMLElement ? match : null;
    };

    const measure = (): void => {
      const composer = parentComposer();
      if (!composer) {
        setComposerInset(0);
        return;
      }
      setComposerInset(
        Math.max(0, column.getBoundingClientRect().bottom - composer.getBoundingClientRect().top)
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    const surface = column.querySelector(".conversation-surface");
    if (surface) observer.observe(surface);
    const composer = parentComposer();
    if (composer) {
      observer.observe(composer);
      if (composer.parentElement) observer.observe(composer.parentElement);
    }
    // The question dock swaps the composer node without necessarily resizing
    // the column, so childList on the surface is what rebinds the landmark.
    const mutation = new MutationObserver(measure);
    if (surface) mutation.observe(surface, { childList: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  // iOS does not move focus when a row is tapped, so a raised keyboard from
  // the parent composer would still be up and squeeze this peek to a sliver.
  // Blur it on open; the composer stays tappable underneath.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const host = hostRef.current;
    if (focused instanceof HTMLElement && !host?.contains(focused)) focused.blur();
  }, []);

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
    if (event.button !== 0 || closing) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    dragOriginY.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onGripPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragOriginY.current === null) return;
    setDragY(Math.max(0, event.clientY - dragOriginY.current));
  };

  const onGripPointerUp = (): void => {
    const distance = dragY;
    dragOriginY.current = null;
    setDragging(false);
    if (distance >= DISMISS_DISTANCE_PX) {
      requestClose();
      return;
    }
    setDragY(0);
  };

  return (
    <div
      className="mobile-agent-overlay"
      ref={hostRef}
      style={{ bottom: `${composerInset}px` }}
    >
      <div className="mobile-agent-overlay-scrim" role="presentation" onClick={requestClose} />
      <div
        className="mobile-agent-overlay-panel"
        role="dialog"
        aria-modal="false"
        aria-label={label}
        data-dragging={dragging || undefined}
        data-closing={closing || undefined}
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
