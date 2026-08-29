import { Info, MessagesSquare, TextQuote } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject
} from "react";

export interface ChatSelection {
  text: string;
}

interface SelectionToolbarProps {
  /** Element whose text content participates in the selection toolbar. A
   *  selection with either endpoint outside it (composer, other panes in the
   *  multi-grid) never shows this instance's toolbar. */
  containerRef: RefObject<HTMLElement | null>;
  onAddToChat: (selection: ChatSelection) => void;
  /** When provided, adds an "Ask in side chat" action that opens a repo-less
   *  side chat seeded with the selection. */
  onAskSideChat?: (selection: ChatSelection) => void;
  /** When provided, adds a "More details" action that opens the explainer
   *  popup seeded with the selection. */
  onMoreDetails?: (selection: ChatSelection) => void;
}

const TOOLBAR_GAP_PX = 6;

interface ActiveSelection extends ChatSelection {
  rect: { left: number; top: number; bottom: number; width: number };
}

/**
 * Floating "Add to chat" toolbar over a text selection in the transcript.
 * Tracks `selectionchange` globally but only claims selections whose range
 * lives inside `containerRef`, so each pane in the multi-grid owns exactly
 * the selections made in its own transcript.
 */
export function SelectionToolbar({
  containerRef,
  onAddToChat,
  onAskSideChat,
  onMoreDetails
}: SelectionToolbarProps): JSX.Element | null {
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // While the primary button is down the selection is still being dragged out;
  // showing (and re-measuring) the toolbar on every selectionchange during the
  // drag makes it chase the cursor. Defer to mouseup instead.
  const pointerDownRef = useRef(false);
  const settleFrameRef = useRef<number | null>(null);
  // Touch surfaces (the phone companion) drag native selection handles with no
  // mousedown/mouseup around them, so the deferral above can't work and the
  // toolbar would fight the OS selection callout. Same gate the composer uses
  // for autofocus.
  const [isCoarsePointer] = useState(
    () => window.matchMedia?.("(pointer: coarse)").matches ?? false
  );

  const syncFromSelection = useCallback((): void => {
    const container = containerRef.current;
    const selection = document.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setActive(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      setActive(null);
      return;
    }
    const text = range.toString().trim();
    if (!text) {
      setActive(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setActive({
      text,
      rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
    });
  }, [containerRef]);

  useEffect(() => {
    if (isCoarsePointer) return;
    const handleSelectionChange = (): void => {
      if (pointerDownRef.current) return;
      syncFromSelection();
    };
    const handleMouseDown = (event: MouseEvent): void => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      pointerDownRef.current = true;
    };
    const handleMouseUp = (): void => {
      pointerDownRef.current = false;
      // The selection settles after mouseup in some engines; measure next tick.
      if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = requestAnimationFrame(() => {
        settleFrameRef.current = null;
        syncFromSelection();
      });
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActive(null);
    };
    const container = containerRef.current;
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keydown", handleKeyDown);
    // Capture-phase so the inner `.conversation-list` scroller (a descendant)
    // re-anchors the toolbar to the selection's new on-screen position.
    container?.addEventListener("scroll", syncFromSelection, true);
    window.addEventListener("resize", syncFromSelection);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keydown", handleKeyDown);
      container?.removeEventListener("scroll", syncFromSelection, true);
      window.removeEventListener("resize", syncFromSelection);
      if (settleFrameRef.current !== null) {
        cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
    };
  }, [containerRef, isCoarsePointer, syncFromSelection]);

  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setPosition(null);
      return;
    }
    const el = toolbarRef.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    let left = active.rect.left + active.rect.width / 2 - size.width / 2;
    left = Math.min(Math.max(12, left), window.innerWidth - 12 - size.width);
    const fitsAbove = active.rect.top - TOOLBAR_GAP_PX - size.height > 12;
    const top = fitsAbove
      ? active.rect.top - TOOLBAR_GAP_PX - size.height
      : active.rect.bottom + TOOLBAR_GAP_PX;
    setPosition({ left, top });
  }, [active]);

  if (isCoarsePointer || !active) return null;

  const consumeSelection = (handler: (selection: ChatSelection) => void): void => {
    handler({ text: active.text });
    document.getSelection()?.removeAllRanges();
    setActive(null);
  };

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      style={position ? { left: `${position.left}px`, top: `${position.top}px` } : { visibility: "hidden" }}
      // Keep the browser from collapsing the selection before click fires.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="selection-toolbar-action"
        aria-label="Add selection to chat"
        title="Attach this excerpt to your next message"
        onClick={() => consumeSelection(onAddToChat)}
      >
        <TextQuote size={13} aria-hidden="true" />
        <span>Add to chat</span>
      </button>
      {onMoreDetails ? (
        <button
          type="button"
          className="selection-toolbar-action"
          aria-label="Explain selection in more detail"
          title="Open an explainer popup about this excerpt"
          onClick={() => consumeSelection(onMoreDetails)}
        >
          <Info size={13} aria-hidden="true" />
          <span>More details</span>
        </button>
      ) : null}
      {onAskSideChat ? (
        <button
          type="button"
          className="selection-toolbar-action"
          aria-label="Ask about selection in side chat"
          title="Open a side chat seeded with this excerpt"
          onClick={() => consumeSelection(onAskSideChat)}
        >
          <MessagesSquare size={13} aria-hidden="true" />
          <span>Ask in side chat</span>
        </button>
      ) : null}
    </div>
  );
}
