import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { decideSmartFollow, latestTurnSpacerPx } from "../lib/smartFollow.js";

const USER_SCROLL_INTENT_MS = 350;
/** How far into the list to sample an in-view node for scroll anchoring. */
const VIEWPORT_ANCHOR_INSET_PX = 48;

type ViewportAnchor = {
  node: Element;
  contentTop: number;
};

function nodeContentTop(scroller: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * The in-view element whose content-coordinate we keep still while detached.
 * WKWebView has no CSS overflow-anchor, so streamed insertions above this
 * node would otherwise slide older transcript into the viewport.
 */
function readViewportAnchor(scroller: HTMLDivElement): ViewportAnchor | null {
  const rect = scroller.getBoundingClientRect();
  if (rect.height < 2 || rect.width < 2) return null;
  const x = rect.left + Math.min(40, Math.max(8, rect.width / 2));
  const y = rect.top + Math.min(VIEWPORT_ANCHOR_INSET_PX, rect.height / 3);
  const node = document.elementFromPoint(x, y);
  if (!(node instanceof Element) || node === scroller || !scroller.contains(node)) return null;
  return { node, contentTop: nodeContentTop(scroller, node) };
}

/** Keys that scroll the list a reader has focus inside. */
export const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " "
]);

export interface SmartFollowScroll {
  /** Attach to the scrollable conversation list `<div>`. */
  conversationListRef: RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled away from the bottom. */
  showScrollToBottom: boolean;
  /** Count of new items that arrived while scrolled up. */
  newBelowCount: number;
  /** Scroll the list to the latest content and resume following. */
  scrollToBottom: () => void;
  /** Record that the next list movement may be user-driven. */
  handleUserScrollIntent: () => void;
  /** Bind to the list's `onScroll`. */
  handleScroll: () => void;
}

/**
 * Keep a conversation at the exact bottom until the reader deliberately moves
 * away. Input alone does not detach the viewport because a downward wheel,
 * PageDown, or touch overscroll at the physical bottom produces no scroll
 * event. A recorded gesture must cause upward movement before following
 * pauses.
 *
 * Item changes run in a layout effect so appended output is visible by the
 * next paint. Resize observers cover streamed growth inside an existing turn
 * and viewport changes caused by the composer or adjacent panels. A leftover
 * spacer after the latest user message is sized first so pinning to the
 * bottom puts that message at the top of the pane until the new turn fills it.
 *
 * The spacer is a follow layout, so it is frozen while the reader is away.
 * Re-attach only when the reader moves toward the bottom (including trackpad
 * momentum) or uses scroll-to-latest / a new user message / a session change.
 * Landing on the bottom because content collapsed under them is not a request
 * to follow, and would pin the latest user message to the top of the pane.
 */
export function useSmartFollowScroll(
  sessionId: string | null | undefined,
  conversationItems: readonly unknown[],
  isThinking: boolean,
  composerRef?: RefObject<HTMLElement | null>,
  lastUserMessageId?: string | null
): SmartFollowScroll {
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const isFollowingRef = useRef(true);
  const userScrollStartTopRef = useRef<number | null>(null);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const lastSeenItemCountRef = useRef(0);
  // Where the reader was when we last saw the list move. Content that shrinks
  // above this point drags the viewport down on its own: the bottom comes to
  // meet the reader rather than the reader scrolling to it.
  const lastScrollTopRef = useRef(0);
  const lastMaxTopRef = useRef(0);
  const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const childResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedChildrenRef = useRef<Set<HTMLElement>>(new Set());

  const clearUserScrollIntent = useCallback((): void => {
    userScrollStartTopRef.current = null;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = null;
    }
  }, []);

  const applyTurnSpacer = useCallback((el: HTMLDivElement): void => {
    const spacer = el.querySelector("[data-conversation-spacer]");
    const anchor = el.querySelector("[data-turn-anchor]");
    const tail = el.querySelector(".conversation-tail");
    if (!(spacer instanceof HTMLElement)) return;
    if (!(anchor instanceof HTMLElement) || !(tail instanceof HTMLElement)) {
      if (spacer.style.height !== "0px") spacer.style.height = "0px";
      return;
    }
    const style = getComputedStyle(el);
    const next = latestTurnSpacerPx({
      viewportHeight: el.clientHeight,
      paddingTop: Number.parseFloat(style.paddingTop) || 0,
      paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
      anchorOffsetTop: anchor.offsetTop,
      contentEnd: tail.offsetTop + tail.offsetHeight
    });
    const px = `${next}px`;
    if (spacer.style.height !== px) spacer.style.height = px;
  }, []);

  const scrollToFollowTarget = useCallback((el: HTMLDivElement, force = false): void => {
    applyTurnSpacer(el);
    if (!force && !isFollowingRef.current) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    lastMaxTopRef.current = top;
    // scrollHeight/clientHeight are rounded but iOS reports fractional
    // scrollTop, so exact equality never settles there — each write fires a
    // scroll event whose handler writes again, fighting the keyboard's
    // caret-reveal pan into a visible per-keystroke bounce.
    if (Math.abs(el.scrollTop - top) > 1) {
      el.scrollTop = top;
      lastScrollTopRef.current = el.scrollTop;
      viewportAnchorRef.current = null;
      // A gesture in flight is measured against where it started, but this
      // write moved the viewport underneath it. Growth streamed in between a
      // wheel event and its scroll event would otherwise read as movement
      // toward the bottom and swallow the reader's scroll away from it. Only
      // a write rebases: a pass that leaves the viewport alone must not
      // consume a user delta smaller than the tolerance above.
      if (userScrollStartTopRef.current !== null) {
        userScrollStartTopRef.current = el.scrollTop;
      }
    }
  }, [applyTurnSpacer]);

  const handleUserScrollIntent = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    if (userScrollStartTopRef.current === null) {
      userScrollStartTopRef.current = el.scrollTop;
    }
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
    }
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollStartTopRef.current = null;
      userScrollIntentTimerRef.current = null;
    }, USER_SCROLL_INTENT_MS);
  }, []);

  const rememberViewportAnchor = useCallback((el: HTMLDivElement): void => {
    viewportAnchorRef.current = readViewportAnchor(el);
  }, []);

  const restoreViewportAnchor = useCallback((el: HTMLDivElement): void => {
    const anchor = viewportAnchorRef.current;
    if (!anchor || !el.contains(anchor.node)) {
      rememberViewportAnchor(el);
      return;
    }
    const nextTop = nodeContentTop(el, anchor.node);
    const delta = nextTop - anchor.contentTop;
    if (Math.abs(delta) > 1) {
      el.scrollTop += delta;
      lastScrollTopRef.current = el.scrollTop;
    }
    // Content-coordinate is independent of scrollTop, so a second pass in the
    // same frame (layout effect + ResizeObserver) sees a zero delta.
    anchor.contentTop = nextTop;
  }, [rememberViewportAnchor]);

  const handleScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const previousTop = lastScrollTopRef.current;
    const previousMax = lastMaxTopRef.current;
    const movedTowardBottom = el.scrollTop > previousTop + 1;
    const contentShrunk = maxTop < previousMax - 1;
    lastScrollTopRef.current = el.scrollTop;
    lastMaxTopRef.current = maxTop;
    const intentStartTop = userScrollStartTopRef.current;
    const movedAwayAfterUserIntent = intentStartTop !== null &&
      el.scrollTop < intentStartTop;
    const movedTowardBottomAfterUserIntent = intentStartTop !== null &&
      el.scrollTop > intentStartTop;

    // Check deliberate upward movement before the near-bottom tolerance. A
    // wheel or trackpad normally moves less than that tolerance per event. If
    // we snapped first, every small delta would be reset and the reader could
    // never accumulate enough movement to detach from the bottom.
    if (movedAwayAfterUserIntent) {
      isFollowingRef.current = false;
      clearUserScrollIntent();
      rememberViewportAnchor(el);
      setShowScrollToBottom(decision.showFab);
      return;
    }

    if (isFollowingRef.current) {
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    const reachedBottom = decision.distanceFromBottom === 0;
    // Re-attach only when the reader moved toward the bottom. Collapse that
    // brings the bottom to them, or a clamp after a shrink, is not a request
    // to follow: pinning would grow the turn spacer and jump them to the
    // latest user message.
    const readerMovedToBottom = !contentShrunk &&
      ((movedTowardBottom && reachedBottom) ||
        (movedTowardBottomAfterUserIntent && decision.pinToBottom));
    if (readerMovedToBottom) {
      isFollowingRef.current = true;
      viewportAnchorRef.current = null;
      clearUserScrollIntent();
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    rememberViewportAnchor(el);
    setShowScrollToBottom(decision.showFab);
  }, [clearUserScrollIntent, rememberViewportAnchor, scrollToFollowTarget]);

  const reconcileScrollAffordance = useCallback((el: HTMLDivElement): void => {
    if (isFollowingRef.current) {
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }
    // Spacer is a follow layout. Mutating it while detached changes
    // scrollHeight and is what used to yank a near-bottom reader to the
    // latest user message once the bottom arrived on its own.
    restoreViewportAnchor(el);
    lastMaxTopRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
    lastScrollTopRef.current = el.scrollTop;
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
    setShowScrollToBottom(decision.showFab);
  }, [restoreViewportAnchor, scrollToFollowTarget]);

  const scrollToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    isFollowingRef.current = true;
    viewportAnchorRef.current = null;
    scrollToFollowTarget(el, true);
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, [clearUserScrollIntent, scrollToFollowTarget]);

  useEffect(() => clearUserScrollIntent, [clearUserScrollIntent]);

  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    isFollowingRef.current = true;
    viewportAnchorRef.current = null;
    scrollToFollowTarget(el, true);
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, [clearUserScrollIntent, lastUserMessageId, scrollToFollowTarget, sessionId]);

  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    if (!isFollowingRef.current) {
      restoreViewportAnchor(el);
      return;
    }
    scrollToFollowTarget(el, true);
  }, [conversationItems, isThinking, restoreViewportAnchor, scrollToFollowTarget]);

  useEffect(() => {
    const current = conversationItems.length;
    const previous = lastSeenItemCountRef.current;
    lastSeenItemCountRef.current = current;
    if (showScrollToBottom && current > previous) {
      setNewBelowCount((count) => count + (current - previous));
    }
  }, [conversationItems, showScrollToBottom]);

  useEffect(() => {
    lastSeenItemCountRef.current = Number.POSITIVE_INFINITY;
    setNewBelowCount(0);
  }, [sessionId]);

  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reconcileScrollAffordance(el));
    observer.observe(el);
    const composer = composerRef?.current;
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [composerRef, reconcileScrollAffordance]);

  // One observer for the list's children, kept across item changes. A stream
  // reallocates `conversationItems` per chunk, so rebuilding the observer here
  // would cost an `observe()` call for every rendered turn, dozens of times a
  // second, on an unvirtualized transcript.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const el = conversationListRef.current;
      if (el) reconcileScrollAffordance(el);
    });
    childResizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      childResizeObserverRef.current = null;
      observedChildrenRef.current = new Set();
    };
  }, [reconcileScrollAffordance]);

  useEffect(() => {
    const el = conversationListRef.current;
    const observer = childResizeObserverRef.current;
    if (!el || !observer) return;
    const observed = observedChildrenRef.current;
    const present = new Set<HTMLElement>();
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.conversationSpacer !== undefined) continue;
      present.add(child);
      if (!observed.has(child)) observer.observe(child);
    }
    for (const child of observed) {
      if (!present.has(child)) observer.unobserve(child);
    }
    observedChildrenRef.current = present;
  }, [conversationItems, reconcileScrollAffordance]);

  return {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleUserScrollIntent,
    handleScroll
  };
}
