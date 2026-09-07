import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const BOTTOM_EPSILON_PX = 1;
const ANCHOR_INSET_PX = 48;
const USER_SCROLLABLE_OVERFLOW = new Set(["auto", "scroll"]);
const STABLE_SCROLLABLE_OVERFLOW = new Set(["auto", "hidden", "scroll"]);

type FollowMode = "following" | "detached";

type ViewportAnchor = {
  node: Element;
  contentTop: number;
};

export interface ConversationScrollOptions {
  sessionId: string | null | undefined;
  items: readonly unknown[];
  resetKey?: string | null;
  enabled?: boolean;
}

export interface ConversationScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  newBelowCount: number;
  scrollToBottom: () => void;
  scrollToElement: (node: HTMLElement) => void;
}

function contentTop(content: HTMLDivElement, node: Element): number {
  return node.getBoundingClientRect().top - content.getBoundingClientRect().top;
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
 * bottom; while detached its measured height is a floor that absorbs folds and
 * removals below the reader.
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
  const detachedHeightFloorRef = useRef(0);
  const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastMaxScrollTopRef = useRef(0);
  const lastItemCountRef = useRef(items.length);
  const requestedScrollTopRef = useRef<number | null>(null);
  const identityRef = useRef({ sessionId, resetKey, enabled });
  const touchYRef = useRef<number | null>(null);
  const touchTargetRef = useRef<EventTarget | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedElementsRef = useRef<Set<Element>>(new Set());
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);

  const rememberAnchor = useCallback((): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    viewportAnchorRef.current = scroll && content ? readViewportAnchor(scroll, content) : null;
  }, []);

  const detach = useCallback((): void => {
    if (modeRef.current === "detached") return;
    const content = contentRef.current;
    modeRef.current = "detached";
    if (content) {
      detachedHeightFloorRef.current = Math.max(
        content.getBoundingClientRect().height,
        content.offsetHeight,
        content.scrollHeight
      );
    }
    rememberAnchor();
    setShowScrollToBottom(true);
  }, [rememberAnchor]);

  const startFollowing = useCallback((): void => {
    modeRef.current = "following";
    detachedHeightFloorRef.current = 0;
    viewportAnchorRef.current = null;
    requestedScrollTopRef.current = null;
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, []);

  /** The sole writer for scroll position and scroll-layout styles. */
  const reconcile = useCallback((): void => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll) return;

    if (!enabled) {
      if (content) content.style.removeProperty("min-height");
      lastScrollTopRef.current = scroll.scrollTop;
      lastMaxScrollTopRef.current = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }
    if (scroll.clientHeight <= 0) return;

    // The browser updates scrollTop before it queues `scroll`. A React commit
    // can therefore land between the user's scrollbar/trackpad movement and
    // our scroll listener. Classify that pending upward move before a follow
    // write can erase it. A reduced scroll range identifies a layout clamp.
    const currentMaxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const rangeShrank = currentMaxTop < lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;
    const clampedToNewBottom =
      rangeShrank &&
      lastScrollTopRef.current > currentMaxTop + BOTTOM_EPSILON_PX &&
      Math.abs(scroll.scrollTop - currentMaxTop) <= BOTTOM_EPSILON_PX;
    if (
      modeRef.current === "following" &&
      scroll.scrollTop < lastScrollTopRef.current - BOTTOM_EPSILON_PX &&
      !clampedToNewBottom
    ) {
      detach();
    } else if (
      modeRef.current === "detached" &&
      scroll.scrollTop > lastScrollTopRef.current &&
      scroll.scrollTop >= lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX &&
      !rangeShrank
    ) {
      // Recognize a return before the queued scroll event is consumed. New
      // output may already have grown past the bottom the reader reached.
      startFollowing();
    }

    if (content) {
      const latestAnchor = Array.from(content.querySelectorAll<HTMLElement>("[data-turn-anchor]"))
        .at(-1);
      let followHeight = 0;
      if (latestAnchor) {
        const paddingTop = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
        followHeight = contentTop(content, latestAnchor) + scroll.clientHeight - paddingTop;
      }
      const minHeight = Math.max(
        0,
        followHeight,
        modeRef.current === "detached"
          ? Math.max(
              detachedHeightFloorRef.current,
              lastMaxScrollTopRef.current + scroll.clientHeight
            )
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
      setShowScrollToBottom(false);
      setNewBelowCount(0);
    } else {
      const requestedTop = requestedScrollTopRef.current;
      requestedScrollTopRef.current = null;
      if (requestedTop !== null) {
        scroll.scrollTop = requestedTop;
        rememberAnchor();
      } else {
        const anchor = viewportAnchorRef.current;
        if (content && anchor && content.contains(anchor.node)) {
          const nextContentTop = contentTop(content, anchor.node);
          const delta = nextContentTop - anchor.contentTop;
          const baseTop = clampedToNewBottom ? lastScrollTopRef.current : scroll.scrollTop;
          if (clampedToNewBottom || Math.abs(delta) > BOTTOM_EPSILON_PX) {
            scroll.scrollTop = baseTop + delta;
          }
          anchor.contentTop = nextContentTop;
        } else if (clampedToNewBottom) {
          scroll.scrollTop = lastScrollTopRef.current;
          rememberAnchor();
        } else {
          rememberAnchor();
        }
      }
      setShowScrollToBottom(true);
    }

    lastScrollTopRef.current = scroll.scrollTop;
    lastMaxScrollTopRef.current = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  }, [detach, enabled, rememberAnchor, startFollowing]);

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
      setNewBelowCount((count) => count + items.length - previousCount);
    }

    const observer = resizeObserverRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (observer && scroll && content) {
      const next = new Set<Element>([scroll, content, ...Array.from(content.children)]);
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

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (scrollableAncestor(scroll, event.target, -1)) return;
      detach();
      reconcile();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!upwardKey(event) || isEditable(event.target)) return;
      if (scrollableAncestor(scroll, event.target, -1)) return;
      detach();
      reconcile();
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
      detach();
      reconcile();
    };
    const clearTouch = (): void => {
      touchYRef.current = null;
      touchTargetRef.current = null;
    };
    const onScroll = (): void => {
      const top = scroll.scrollTop;
      const previousTop = lastScrollTopRef.current;
      const height = scroll.scrollHeight;
      const maxTop = Math.max(0, height - scroll.clientHeight);
      const rangeShrank = maxTop < lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;
      const clampedToNewBottom =
        rangeShrank &&
        previousTop > maxTop + BOTTOM_EPSILON_PX &&
        Math.abs(top - maxTop) <= BOTTOM_EPSILON_PX;
      const movedUp = top < previousTop - BOTTOM_EPSILON_PX;
      const movedDown = top > previousTop;
      const reachedPreviousBottom = top >= lastMaxScrollTopRef.current - BOTTOM_EPSILON_PX;

      if (modeRef.current === "following" && movedUp && !clampedToNewBottom) {
        detach();
      } else if (modeRef.current === "detached" && movedDown && reachedPreviousBottom && !rangeShrank) {
        startFollowing();
      }

      // A viewport/content-range clamp is browser layout, not reader input.
      // Keep the pre-clamp position and anchor until ResizeObserver restores
      // the detached range through `reconcile`.
      if (modeRef.current === "detached" && clampedToNewBottom) return;

      lastScrollTopRef.current = top;
      lastMaxScrollTopRef.current = maxTop;
      if (modeRef.current === "detached") rememberAnchor();
    };

    scroll.addEventListener("wheel", onWheel, { passive: true });
    scroll.addEventListener("keydown", onKeyDown);
    scroll.addEventListener("touchstart", onTouchStart, { passive: true });
    scroll.addEventListener("touchmove", onTouchMove, { passive: true });
    scroll.addEventListener("touchend", clearTouch, { passive: true });
    scroll.addEventListener("touchcancel", clearTouch, { passive: true });
    scroll.addEventListener("scroll", onScroll, { passive: true });

    let resizeFrame: number | null = null;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // Releasing the height floor can resize an observed ancestor. Write in
      // the next frame, outside ResizeObserver's current delivery cycle.
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        reconcile();
      });
    });
    resizeObserverRef.current = observer;
    const observed = new Set<Element>([scroll]);
    if (content) {
      observed.add(content);
      for (const child of Array.from(content.children)) observed.add(child);
    }
    for (const element of observed) observer?.observe(element);
    observedElementsRef.current = observed;

    return () => {
      scroll.removeEventListener("wheel", onWheel);
      scroll.removeEventListener("keydown", onKeyDown);
      scroll.removeEventListener("touchstart", onTouchStart);
      scroll.removeEventListener("touchmove", onTouchMove);
      scroll.removeEventListener("touchend", clearTouch);
      scroll.removeEventListener("touchcancel", clearTouch);
      scroll.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeObserverRef.current = null;
      observedElementsRef.current = new Set();
      clearTouch();
    };
  }, [detach, enabled, reconcile, rememberAnchor, resetKey, sessionId, startFollowing]);

  return {
    scrollRef,
    contentRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    scrollToElement
  };
}
