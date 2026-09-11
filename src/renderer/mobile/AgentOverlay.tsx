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
    <div className="mobile-agent-overlay" ref={hostRef}>
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
