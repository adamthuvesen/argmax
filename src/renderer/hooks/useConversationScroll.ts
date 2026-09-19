import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { attachSmoothWheel } from "../lib/smoothWheel.js";

const BOTTOM_EPSILON_PX = 1;
const ANCHOR_INSET_PX = 48;
const USER_SCROLLABLE_OVERFLOW = new Set(["auto", "scroll"]);
const STABLE_SCROLLABLE_OVERFLOW = new Set(["auto", "hidden", "scroll"]);

type FollowMode = "following" | "detached";

type ViewportAnchor = {
  node: Element;
  contentTop: number;
};

interface ConversationScrollOptions {
  sessionId: string | null | undefined;
  items: readonly unknown[];
  resetKey?: string | null;
  enabled?: boolean;
}

/**
 * Whether the reader has scrolled away from the latest output, kept outside
 * React state. A detach lands in the middle of the reader's scroll, and as
 * host state it re-rendered every mounted turn there. Only the components
 * that show it subscribe; the rest read it when they render anyway.
 */
export interface TranscriptFollow {
  isDetached: () => boolean;
  /** Rows that arrived below the reader since they detached. */
  newBelowCount: () => number;
  subscribe: (listener: () => void) => () => void;
}

export const ALWAYS_FOLLOWING: TranscriptFollow = {
  isDetached: () => false,
  newBelowCount: () => 0,
  subscribe: () => () => undefined
};

export function useTranscriptFollow(follow: TranscriptFollow): {
  detached: boolean;
  newBelowCount: number;
} {
  const detached = useSyncExternalStore(follow.subscribe, follow.isDetached);
  const newBelowCount = useSyncExternalStore(follow.subscribe, follow.newBelowCount);
  return { detached, newBelowCount };
}

export interface ConversationScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  follow: TranscriptFollow;
  scrollToBottom: () => void;
  scrollToElement: (node: HTMLElement) => void;
}

function contentTop(content: HTMLDivElement, node: Element): number {
  return node.getBoundingClientRect().top - content.getBoundingClientRect().top;
}

function physicalScrollTop(scroll: HTMLDivElement, maxTop: number): number {
  return Math.max(0, Math.min(scroll.scrollTop, maxTop));
}

function scrollableAncestor(
  scroll: HTMLDivElement,
  target: EventTarget | null,
  direction: -1 | 1
): HTMLElement | null {
  let node = target instanceof Element ? target : null;
  while (node && node !== scroll) {
    if (node instanceof HTMLElement) {
      const overflowY = getComputedStyle(node).overflowY;
      const maxTop = node.scrollHeight - node.clientHeight;
      if (USER_SCROLLABLE_OVERFLOW.has(overflowY) && maxTop > BOTTOM_EPSILON_PX) {
        const canScrollUp = direction < 0 && node.scrollTop > BOTTOM_EPSILON_PX;
        const canScrollDown = direction > 0 && node.scrollTop < maxTop - BOTTOM_EPSILON_PX;
        if (canScrollUp || canScrollDown) return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function stableNestedScroller(
  content: HTMLDivElement,
  directChild: Element,
  hit: Element
): Element | null {
  let stable: Element | null = null;
  let node: Element | null = hit;
  while (node && node !== content) {
    if (node instanceof HTMLElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if (
        STABLE_SCROLLABLE_OVERFLOW.has(overflowY) &&
        node.scrollHeight > node.clientHeight + BOTTOM_EPSILON_PX
      ) {
        stable = node;
      }
    }
    if (node === directChild) break;
    node = node.parentElement;
  }
  return stable;
}

function stableBlock(directChild: Element, hit: Element): Element {
  let node: Element | null = hit;
  while (node && node !== directChild) {
    const display = getComputedStyle(node).display;
    if (display !== "inline" && display !== "contents" && node.getBoundingClientRect().height > 0) {
      return node;
    }
    node = node.parentElement;
  }
  return directChild;
}

/**
 * Keep a stable transcript child at the same viewport coordinate while the
 * reader is detached. A nested scroll area's outer box is the anchor because
 * movement inside it must not move the conversation on the next stream tick.
 */
function readViewportAnchor(
  scroll: HTMLDivElement,
  content: HTMLDivElement
): ViewportAnchor | null {
  const scrollRect = scroll.getBoundingClientRect();
  if (scrollRect.width < 2 || scrollRect.height < 2) return null;
  const y = scrollRect.top + Math.min(ANCHOR_INSET_PX, scrollRect.height / 3);
  const directChild = Array.from(content.children).find((child) => {
    const rect = child.getBoundingClientRect();
    return rect.bottom >= y;
  });
  if (!directChild) return null;

  const contentStyle = getComputedStyle(content);
  const paddingLeft = Number.parseFloat(contentStyle.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(contentStyle.paddingRight) || 0;
  const width = Math.max(0, scrollRect.width - paddingLeft - paddingRight);
  const hit = document.elementFromPoint(scrollRect.left + paddingLeft + width / 2, y);
  const node =
    hit instanceof Element && directChild.contains(hit)
      ? stableNestedScroller(content, directChild, hit) ?? stableBlock(directChild, hit)
      : directChild;
  return { node, contentTop: contentTop(content, node) };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function upwardKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

/**
 * Owns native input, bottom following, and detached viewport preservation for
 * a conversation. The content element is the only layout shim: while following
 * it is tall enough to place the latest prompt at the top at the physical
 * bottom; while detached it reaches at least to the bottom of the reader's
 * viewport, which absorbs folds and removals below them.
 */
export function useConversationScroll({
  sessionId,
  items,
  resetKey = null,
  enabled = true
}: ConversationScrollOptions): ConversationScroll {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<FollowMode>("following");
  const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastMaxScrollTopRef = useRef(0);
  const lastItemCountRef = useRef(items.length);
  const requestedScrollTopRef = useRef<number | null>(null);
  const identityRef = useRef({ sessionId, resetKey, enabled });
  const touchYRef = useRef<number | null>(null);
  const touchTargetRef = useRef<EventTarget | null>(null);
  const pointerScrollRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedElementsRef = useRef<Set<Element>>(new Set());
  const newBelowCountRef = useRef(0);
  const followListenersRef = useRef(new Set<() => void>());
  const [follow] = useState<TranscriptFollow>(() => ({
    isDetached: () => modeRef.current === "detached",
    newBelowCount: () => newBelowCountRef.current,
    subscribe: (listener) => {
      followListenersRef.current.add(listener);
      return () => followListenersRef.current.delete(listener);
    }
  }));
  const notifyFollow = useCallback((): void => {
    for (const listener of followListenersRef.current) listener();
  }, []);
  const resetNewBelowCount = useCallback((): void => {
    if (newBelowCountRef.current === 0) return;
    newBelowCountRef.current = 0;
    notifyFollow();
  }, [notifyFollow]);

  const rememberAnchor = useCallback((): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    viewportAnchorRef.current = scroll && content ? readViewportAnchor(scroll, content) : null;
  }, []);

  const detach = useCallback((): void => {
    if (modeRef.current === "detached") return;
    modeRef.current = "detached";
    rememberAnchor();
    notifyFollow();
  }, [notifyFollow, rememberAnchor]);

  const startFollowing = useCallback((): void => {
    const wasDetached = modeRef.current === "detached";
    modeRef.current = "following";
    viewportAnchorRef.current = null;
    requestedScrollTopRef.current = null;
    newBelowCountRef.current = 0;
    if (wasDetached) notifyFollow();
  }, [notifyFollow]);

  /** The sole writer for scroll position and scroll-layout styles. */
  const reconcile = useCallback((): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll) return;

    if (!enabled) {
      if (content) content.style.removeProperty("min-height");
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      lastScrollTopRef.current = physicalScrollTop(scroll, maxTop);
      lastMaxScrollTopRef.current = maxTop;
      resetNewBelowCount();
      return;
    }
    if (scroll.clientHeight <= 0) return;

    // The browser updates scrollTop before it queues `scroll`. A React commit
    // can therefore land between the user's scrollbar/trackpad movement and
    // our scroll listener. Classify that pending upward move before a follow
    // write can erase it. A reduced scroll range identifies a layout clamp.
    const currentMaxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const currentTop = physicalScrollTop(scroll, currentMaxTop);
    const rangeShrank = currentMaxTop < lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;
    const clampedToNewBottom =
      rangeShrank &&
      lastScrollTopRef.current > currentMaxTop + BOTTOM_EPSILON_PX &&
      Math.abs(currentTop - currentMaxTop) <= BOTTOM_EPSILON_PX;
    if (
      modeRef.current === "following" &&
      currentTop < lastScrollTopRef.current - BOTTOM_EPSILON_PX &&
      pointerScrollRef.current &&
      !clampedToNewBottom
    ) {
      detach();
    } else if (
      modeRef.current === "detached" &&
      currentTop > lastScrollTopRef.current &&
      currentTop >= lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX &&
      !rangeShrank
    ) {
      // Recognize a return before the queued scroll event is consumed. New
      // output may already have grown past the bottom the reader reached.
      startFollowing();
    }

    // Where a detached reader's viewport belongs after this change, or null to
    // leave it where it is. Decided before the height write so the floor can
    // be sized to it.
    let detachedTop: number | null = null;
    if (modeRef.current === "detached") {
      const requestedTop = requestedScrollTopRef.current;
      requestedScrollTopRef.current = null;
      const anchor = viewportAnchorRef.current;
      if (requestedTop !== null) {
        detachedTop = Math.min(requestedTop, currentMaxTop);
        // Re-read below once the requested position is applied.
        viewportAnchorRef.current = null;
      } else if (content && anchor && content.contains(anchor.node)) {
        const nextContentTop = contentTop(content, anchor.node);
        const delta = nextContentTop - anchor.contentTop;
        const baseTop = clampedToNewBottom ? lastScrollTopRef.current : currentTop;
        if (clampedToNewBottom || Math.abs(delta) > BOTTOM_EPSILON_PX) detachedTop = baseTop + delta;
        anchor.contentTop = nextContentTop;
      } else if (clampedToNewBottom) {
        detachedTop = lastScrollTopRef.current;
      }
    }

    if (content) {
      const latestAnchor = Array.from(content.querySelectorAll<HTMLElement>("[data-turn-anchor]"))
        .at(-1);
      let followHeight = 0;
      if (latestAnchor) {
        const paddingTop = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
        followHeight = contentTop(content, latestAnchor) + scroll.clientHeight - paddingTop;
      }
      // A detached reader's floor reaches exactly to the bottom of their
      // viewport: a fold or removal below them cannot clamp the view, and
      // nothing they haven't seen is kept as blank range to scroll into. A
      // floor sized from an earlier range only ever grew — every collapse and
      // every viewport shrink-and-regrow left its height behind.
      const minHeight = Math.max(
        0,
        followHeight,
        modeRef.current === "detached"
          ? (detachedTop ?? currentTop) + scroll.clientHeight
          : 0
      );
      const nextMinHeight = minHeight > 0 ? `${minHeight}px` : "";
      if (content.style.minHeight !== nextMinHeight) content.style.minHeight = nextMinHeight;
    }

    if (modeRef.current === "following") {
      if (content) {
        // Retain the settled height until the next reconciliation. Replacing
        // streamed rows can briefly shrink and then regrow the content before
        // any callback runs. Prevent that intermediate layout from clamping
        // scrollTop upward and looking like reader input. The min-height write
        // above releases this floor first so permanent folds still shrink.
        content.style.minHeight = `${content.getBoundingClientRect().height}px`;
      }
      const bottom = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (Math.abs(scroll.scrollTop - bottom) > BOTTOM_EPSILON_PX) scroll.scrollTop = bottom;
      viewportAnchorRef.current = null;
      resetNewBelowCount();
    } else {
      if (detachedTop !== null) scroll.scrollTop = detachedTop;
      const anchor = viewportAnchorRef.current;
      if (!content || !anchor || !content.contains(anchor.node)) rememberAnchor();
    }

    const settledMaxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    lastScrollTopRef.current = physicalScrollTop(scroll, settledMaxTop);
    lastMaxScrollTopRef.current = settledMaxTop;
  }, [detach, enabled, rememberAnchor, resetNewBelowCount, startFollowing]);

  const scrollToBottom = useCallback((): void => {
    startFollowing();
    lastItemCountRef.current = items.length;
    reconcile();
  }, [items.length, reconcile, startFollowing]);

  const scrollToElement = useCallback((node: HTMLElement): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || !content.contains(node)) return;
    detach();
    requestedScrollTopRef.current =
      scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    reconcile();
  }, [detach, reconcile]);

  // Reconcile before every paint. This covers child replacement and prepend
  // commits; ResizeObserver handles size changes that happen without React.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reconciliation intentionally runs after every commit
  useLayoutEffect(() => {
    const previous = identityRef.current;
    const reset =
      previous.sessionId !== sessionId ||
      previous.resetKey !== resetKey ||
      previous.enabled !== enabled;
    identityRef.current = { sessionId, resetKey, enabled };
    if (reset) startFollowing();

    const previousCount = lastItemCountRef.current;
    lastItemCountRef.current = items.length;
    reconcile();
    if (!reset && modeRef.current === "detached" && items.length > previousCount) {
      newBelowCountRef.current += items.length - previousCount;
      notifyFollow();
    }

    const observer = resizeObserverRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (observer && scroll && content) {
      const next = new Set<Element>([scroll, ...Array.from(content.children)]);
      for (const element of next) {
        if (!observedElementsRef.current.has(element)) observer.observe(element);
      }
      for (const element of observedElementsRef.current) {
        if (!next.has(element)) observer.unobserve(element);
      }
      observedElementsRef.current = next;
    }
  });

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !scroll) return;

    // Release following for the gesture, then take it back if the gesture
    // turned out to move nothing. A reader who is already at the physical
    // bottom can produce upward input the scroller cannot act on — the
    // macOS overscroll bounce reports negative wheel deltas as it snaps
    // back, and a thumb's drift on a tap reports an upward touch — and a
    // detach there is permanent: with nowhere left to move, no scroll event
    // can ever arrive to end it, so the scroll-to-latest button stays on a
    // conversation that is already at its end and new output stops being
    // followed. Two frames, because a wheel scroll is composited and its
    // scrollTop can land after the frame the event was dispatched in.
    const releaseFollowing = (): void => {
      // Every notch of a wheel scroll lands here. Once detached there is
      // nothing to release, and reconciling would measure the transcript
      // on each one.
      if (modeRef.current === "detached") return;
      const bottomBeforeGesture = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const topBeforeGesture = physicalScrollTop(scroll, bottomBeforeGesture);
      detach();
      reconcile();
      if (topBeforeGesture < bottomBeforeGesture - BOTTOM_EPSILON_PX) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (modeRef.current !== "detached") return;
        if (Math.abs(physicalScrollTop(scroll, bottomBeforeGesture) - topBeforeGesture) > BOTTOM_EPSILON_PX) return;
        startFollowing();
        reconcile();
      }));
    };

    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (event.deltaY > 0) {
        // A collapse below can leave a detached reader at the physical
        // bottom, where scrolling down moves nothing and so never raises the
        // scroll event that would resume following. Take the input instead.
        if (modeRef.current !== "detached") return;
        const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (physicalScrollTop(scroll, maxTop) < maxTop - BOTTOM_EPSILON_PX) return;
        if (scrollableAncestor(scroll, event.target, 1)) return;
        startFollowing();
        reconcile();
        return;
      }
      if (scrollableAncestor(scroll, event.target, -1)) return;
      releaseFollowing();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!upwardKey(event) || isEditable(event.target)) return;
      if (scrollableAncestor(scroll, event.target, -1)) return;
      releaseFollowing();
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        touchYRef.current = null;
        touchTargetRef.current = null;
        return;
      }
      touchYRef.current = event.touches[0]?.clientY ?? null;
      touchTargetRef.current = event.target;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const previousY = touchYRef.current;
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (previousY === null || !touch) return;
      const deltaY = touch.clientY - previousY;
      touchYRef.current = touch.clientY;
      if (deltaY <= BOTTOM_EPSILON_PX) return;
      if (scrollableAncestor(scroll, touchTargetRef.current, -1)) return;
      releaseFollowing();
    };
    const clearTouch = (): void => {
      touchYRef.current = null;
      touchTargetRef.current = null;
    };
    const onPointerDown = (): void => {
      pointerScrollRef.current = true;
    };
    const clearPointer = (): void => {
      pointerScrollRef.current = false;
    };
    const onScroll = (): void => {
      const previousTop = lastScrollTopRef.current;
      const height = scroll.scrollHeight;
      const maxTop = Math.max(0, height - scroll.clientHeight);
      // WebKit exposes elastic positions outside [0, maxTop]. A bounce back
      // from that visual overscroll is not reader movement through content.
      const top = physicalScrollTop(scroll, maxTop);
      const rangeShrank = maxTop < lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;
      const clampedToNewBottom =
        rangeShrank &&
        previousTop > maxTop + BOTTOM_EPSILON_PX &&
        Math.abs(top - maxTop) <= BOTTOM_EPSILON_PX;
      const movedUp = top < previousTop - BOTTOM_EPSILON_PX;
      const movedDown = top > previousTop;
      const reachedPreviousBottom = top >= lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;

      if (
        modeRef.current === "following" &&
        movedUp &&
        pointerScrollRef.current &&
        !clampedToNewBottom
      ) {
        detach();
      } else if (modeRef.current === "detached" && movedDown && reachedPreviousBottom && !rangeShrank) {
        startFollowing();
      }

      // A viewport/content-range clamp is browser layout, not reader input.
      // Keep the pre-clamp position and anchor until ResizeObserver restores
      // the detached range through `reconcile`.
      if (modeRef.current === "detached" && clampedToNewBottom) return;

      // Width reflow can move WebKit's scrollTop without reader input. This is
      // especially visible when opening a wide dock first squeezes the chat,
      // then folding the app sidebar widens it again. Stay attached and put
      // the latest turn back at the bottom instead of preserving the empty
      // min-height tail as a reading position. Wheel, key and touch gestures
      // detach before their scroll event; a scrollbar drag is covered by the
      // active pointer gesture above.
      if (modeRef.current === "following" && movedUp && !clampedToNewBottom) {
        reconcile();
        return;
      }

      lastScrollTopRef.current = top;
      lastMaxScrollTopRef.current = maxTop;
      if (modeRef.current === "detached") rememberAnchor();
    };

    scroll.addEventListener("wheel", onWheel, { passive: true });
    const detachSmoothWheel = attachSmoothWheel(scroll);
    scroll.addEventListener("keydown", onKeyDown);
    scroll.addEventListener("touchstart", onTouchStart, { passive: true });
    scroll.addEventListener("touchmove", onTouchMove, { passive: true });
    scroll.addEventListener("touchend", clearTouch, { passive: true });
    scroll.addEventListener("touchcancel", clearTouch, { passive: true });
    scroll.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroll.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("pointerup", clearPointer);
    document.addEventListener("pointercancel", clearPointer);

    // Correct row reflow before paint. The wrapper's height is controlled by
    // reconcile, so observing it would feed our own layout writes back into
    // ResizeObserver. Its non-shrinking children report the content changes.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reconcile);
    resizeObserverRef.current = observer;
    const observed = new Set<Element>([scroll]);
    if (content) {
      for (const child of Array.from(content.children)) observed.add(child);
    }
    for (const element of observed) observer?.observe(element);
    observedElementsRef.current = observed;

    return () => {
      scroll.removeEventListener("wheel", onWheel);
      detachSmoothWheel();
      scroll.removeEventListener("keydown", onKeyDown);
      scroll.removeEventListener("touchstart", onTouchStart);
      scroll.removeEventListener("touchmove", onTouchMove);
      scroll.removeEventListener("touchend", clearTouch);
      scroll.removeEventListener("touchcancel", clearTouch);
      scroll.removeEventListener("pointerdown", onPointerDown);
      scroll.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointerup", clearPointer);
      document.removeEventListener("pointercancel", clearPointer);
      observer?.disconnect();
      resizeObserverRef.current = null;
      observedElementsRef.current = new Set();
      clearTouch();
      clearPointer();
    };
  }, [detach, enabled, reconcile, rememberAnchor, resetKey, sessionId, startFollowing]);

  return {
    scrollRef,
    contentRef,
    follow,
    scrollToBottom,
    scrollToElement
  };
}
