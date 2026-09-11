import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { getBrowserTabs, moveBrowserTab } from "../lib/browserPanel.js";

// Carrying a browser tab to another slot.
//
// Pointer events, not HTML5 drag and drop: the strip wants the tab under the
// cursor from the first pixel and its neighbours sliding out of the way, which
// a drag image and `dragover` cannot give — and this app's drag-and-drop is
// the one input path that wedges (see lib/dragLog.ts), so a reorder that never
// opens a WebKit drag session is one fewer way to lose the strip.
//
// Nothing commits until the drop lands. Neighbours are displaced with a
// transform while the carry is in flight, so the tab list itself never
// reorders under the pointer and a `browser:tabs` push mid-carry cannot fight
// the geometry measured at the press.

/** Pointer travel that tells carrying a tab from clicking it. */
const CARRY_THRESHOLD_PX = 4;
/** Band at each end of an overflowing strip that scrolls while carrying. */
const EDGE_BAND_PX = 28;
const EDGE_STEP_PX = 14;

/** A tab's resting box, in the strip's content coordinates. */
interface Slot {
  left: number;
  right: number;
  center: number;
}

/**
 * Measured once at the press. Content coordinates (client x plus `scrollLeft`)
 * so scrolling the strip mid-carry cannot move the geometry out from under
 * the pointer.
 */
interface Grab {
  id: string;
  pointerId: number;
  fromIndex: number;
  toIndex: number;
  /** Tab ids in strip order at the press, for addressing the landing slot. */
  order: string[];
  slots: Slot[];
  /** Pixels a displaced neighbour slides: the carried tab's width plus the gap. */
  shift: number;
  /** Press position, in content coordinates. */
  grabX: number;
  clientX: number;
  startClientX: number;
  offset: number;
  carrying: boolean;
  frame: number | null;
}

/** What the strip renders while a tab is in flight. */
interface TabCarry {
  fromIndex: number;
  toIndex: number;
  /** Pixels the carried tab sits from its own slot. */
  offset: number;
  shift: number;
  /** True while the tab settles into the slot it was dropped in. */
  dropping: boolean;
}

export interface BrowserTabDrag {
  stripRef: RefObject<HTMLDivElement | null>;
  /** True from the moment a press becomes a carry until the drop settles. */
  carrying: boolean;
  begin: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  /** `data-drag` for the tab at `index`, or nothing when it is at rest. */
  phaseOf: (index: number) => "carry" | "drop" | undefined;
  styleOf: (index: number) => CSSProperties | undefined;
  /**
   * True for the click a finished carry synthesizes, which must not also be
   * read as a tab switch. Consumed on read.
   */
  consumeClick: () => boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Where the carried tab comes to rest once it lands in `to`. */
function restOffset(slots: readonly Slot[], from: number, to: number): number {
  const slot = slots[from];
  const target = slots[to];
  if (!slot || !target || to === from) return 0;
  return to > from ? target.right - slot.right : target.left - slot.left;
}

/**
 * The strip's own `--duration-fast`, so the settle and the CSS transition
 * cannot drift — and "reduce motion", which zeroes the token, drops the tab
 * into place at once rather than pausing on an animation nobody sees.
 */
function dropDurationMs(strip: HTMLElement | null): number {
  if (!strip || typeof window === "undefined") return 0;
  const raw = window.getComputedStyle(strip).getPropertyValue("--duration-fast").trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith("ms") ? value : value * 1000;
}

/**
 * Drag-to-reorder for the browser tab strip. `onPick` runs on the press, the
 * way a browser selects the tab you grab before you have moved it.
 */
export function useBrowserTabDrag(scopeId: string, onPick: (id: string) => void): BrowserTabDrag {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef<Grab | null>(null);
  const dropRef = useRef<{ timer: ReturnType<typeof setTimeout>; land: () => void } | null>(null);
  const clickRef = useRef(false);
  const [carry, setCarry] = useState<TabCarry | null>(null);

  /**
   * Reorders and clears the carry in one render: the strip loses its
   * `data-dragging` transitions at the same moment the tabs change places, so
   * no transform animates against the new layout.
   */
  const land = useCallback(
    (id: string, anchorId: string | null, fromIndex: number, toIndex: number): void => {
      if (toIndex !== fromIndex) {
        // Address the landing slot by the tab it displaces: a registry push
        // during the carry can add or drop tabs, and an index captured at the
        // press would then point at a stranger.
        const live = getBrowserTabs(scopeId);
        const anchor = anchorId ? live.findIndex((tab) => tab.id === anchorId) : -1;
        moveBrowserTab(id, anchor === -1 ? toIndex : anchor);
      }
      setCarry(null);
    },
    [scopeId]
  );

  /** Lands a drop that is still settling, so the next press measures a strip
   *  whose order is final. */
  const flushDrop = useCallback((): void => {
    const pending = dropRef.current;
    if (!pending) return;
    dropRef.current = null;
    clearTimeout(pending.timer);
    pending.land();
  }, []);

  const track = useCallback((): void => {
    const grab = grabRef.current;
    const strip = stripRef.current;
    if (!grab || !strip || !grab.carrying) return;
    const slot = grab.slots[grab.fromIndex];
    const first = grab.slots[0];
    const last = grab.slots[grab.slots.length - 1];
    if (!slot || !first || !last) return;
    const rect = strip.getBoundingClientRect();
    const pointerX = grab.clientX - rect.left + strip.scrollLeft;
    // Clamped to the run of tabs: the carried tab never leaves the strip, and
    // never adds scrollable width of its own.
    const offset = clamp(pointerX - grab.grabX, first.left - slot.left, last.right - slot.right);
    const center = slot.center + offset;
    // The slot the tab has earned is however many of the others it has passed
    // the middle of — right for uneven widths too, unlike a division by pitch.
    let toIndex = 0;
    for (const [index, other] of grab.slots.entries()) {
      if (index !== grab.fromIndex && other.center < center) toIndex += 1;
    }
    grab.offset = offset;
    grab.toIndex = toIndex;
    setCarry({ fromIndex: grab.fromIndex, toIndex, offset, shift: grab.shift, dropping: false });
  }, []);

  /** Scrolls an overflowing strip while the pointer rests in an edge band, so
   *  a tab can be carried past the tabs currently on screen. */
  const edgeScroll = useCallback((): void => {
    const grab = grabRef.current;
    const strip = stripRef.current;
    if (!grab || !strip) return;
    const overflow = strip.scrollWidth - strip.clientWidth;
    if (overflow > 0) {
      const rect = strip.getBoundingClientRect();
      let step = 0;
      if (grab.clientX < rect.left + EDGE_BAND_PX) step = -EDGE_STEP_PX;
      else if (grab.clientX > rect.right - EDGE_BAND_PX) step = EDGE_STEP_PX;
      if (step !== 0) {
        const before = strip.scrollLeft;
        strip.scrollLeft = clamp(before + step, 0, overflow);
        if (strip.scrollLeft !== before) track();
      }
    }
    grab.frame = requestAnimationFrame(edgeScroll);
  }, [track]);

  const release = useCallback((): void => {
    const grab = grabRef.current;
    if (grab && grab.frame !== null) cancelAnimationFrame(grab.frame);
    grabRef.current = null;
  }, []);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string): void => {
      // A secondary or modified press belongs to the context menu, not a carry.
      if (event.button !== 0 || event.ctrlKey || grabRef.current) return;
      clickRef.current = false;
      flushDrop();
      onPick(id);
      const strip = stripRef.current;
      if (!strip) return;
      const list = getBrowserTabs(scopeId);
      const fromIndex = list.findIndex((tab) => tab.id === id);
      if (fromIndex === -1 || list.length < 2) return;
      const nodes = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
      if (nodes.length !== list.length) return;
      const rect = strip.getBoundingClientRect();
      const slots = nodes.map((node): Slot => {
        const box = node.getBoundingClientRect();
        const left = box.left - rect.left + strip.scrollLeft;
        const right = left + box.width;
        return { left, right, center: (left + right) / 2 };
      });
      const slot = slots[fromIndex];
      const first = slots[0];
      const second = slots[1];
      if (!slot || !first || !second) return;
      grabRef.current = {
        id,
        pointerId: event.pointerId,
        fromIndex,
        toIndex: fromIndex,
        order: list.map((tab) => tab.id),
        slots,
        shift: slot.right - slot.left + (second.left - first.right),
        grabX: event.clientX - rect.left + strip.scrollLeft,
        clientX: event.clientX,
        startClientX: event.clientX,
        offset: 0,
        carrying: false,
        frame: null
      };
    },
    [flushDrop, onPick, scopeId]
  );

  // The pointer leaves the strip on any real carry, so the window owns the
  // rest of the gesture. Listening for the whole panel's life costs three
  // idle listeners and spares every press an attach/detach pair.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const grab = grabRef.current;
      if (!grab || event.pointerId !== grab.pointerId) return;
      grab.clientX = event.clientX;
      if (!grab.carrying) {
        if (Math.abs(event.clientX - grab.startClientX) < CARRY_THRESHOLD_PX) return;
        grab.carrying = true;
        grab.frame = requestAnimationFrame(edgeScroll);
      }
      track();
    };
    const onUp = (event: PointerEvent): void => {
      const grab = grabRef.current;
      if (!grab || event.pointerId !== grab.pointerId) return;
      const { id, fromIndex, toIndex, order, slots, shift, carrying } = grab;
      release();
      if (!carrying) return;
      // The press that started the carry also synthesizes a click on release.
      clickRef.current = true;
      const anchorId = order[toIndex] ?? null;
      const settle = (): void => land(id, anchorId, fromIndex, toIndex);
      const duration = dropDurationMs(stripRef.current);
      if (duration <= 0) {
        settle();
        return;
      }
      // Let the tab travel the last stretch into its slot, then commit at the
      // end of that ride — where the list's own layout already puts it.
      setCarry({ fromIndex, toIndex, offset: restOffset(slots, fromIndex, toIndex), shift, dropping: true });
      dropRef.current = {
        land: settle,
        timer: setTimeout(() => {
          dropRef.current = null;
          settle();
        }, duration)
      };
    };
    const onCancel = (event: PointerEvent): void => {
      const grab = grabRef.current;
      if (!grab || event.pointerId !== grab.pointerId) return;
      release();
      setCarry(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [edgeScroll, land, release, track]);

  // A panel that unmounts mid-settle still owes the user their drop.
  useEffect(() => flushDrop, [flushDrop]);

  const phaseOf = useCallback(
    (index: number): "carry" | "drop" | undefined => {
      if (!carry || index !== carry.fromIndex) return undefined;
      return carry.dropping ? "drop" : "carry";
    },
    [carry]
  );

  const styleOf = useCallback(
    (index: number): CSSProperties | undefined => {
      if (!carry) return undefined;
      const { fromIndex, toIndex, offset, shift } = carry;
      if (index === fromIndex) return { transform: `translateX(${offset}px)`, zIndex: 2 };
      const displaced =
        toIndex > fromIndex
          ? index > fromIndex && index <= toIndex
          : index >= toIndex && index < fromIndex;
      if (!displaced) return undefined;
      return { transform: `translateX(${toIndex > fromIndex ? -shift : shift}px)` };
    },
    [carry]
  );

  const consumeClick = useCallback((): boolean => {
    const consumed = clickRef.current;
    clickRef.current = false;
    return consumed;
  }, []);

  return { stripRef, carrying: carry !== null, begin, phaseOf, styleOf, consumeClick };
}
