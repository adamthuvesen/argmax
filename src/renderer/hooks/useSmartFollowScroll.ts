import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { decideSmartFollow } from "../lib/smartFollow.js";

const USER_SCROLL_INTENT_MS = 350;

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
 * and viewport changes caused by the composer or adjacent panels.
 */
export function useSmartFollowScroll(
  sessionId: string | null | undefined,
  conversationItems: readonly unknown[],
  isThinking: boolean,
  composerRef?: RefObject<HTMLElement | null>
): SmartFollowScroll {
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const isFollowingRef = useRef(true);
  const userScrollStartTopRef = useRef<number | null>(null);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const lastSeenItemCountRef = useRef(0);
  const childResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedChildrenRef = useRef<Set<HTMLElement>>(new Set());

  const clearUserScrollIntent = useCallback((): void => {
    userScrollStartTopRef.current = null;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = null;
    }
  }, []);

  const scrollToFollowTarget = useCallback((el: HTMLDivElement, force = false): void => {
    if (!force && !isFollowingRef.current) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    // scrollHeight/clientHeight are rounded but iOS reports fractional
    // scrollTop, so exact equality never settles there — each write fires a
    // scroll event whose handler writes again, fighting the keyboard's
    // caret-reveal pan into a visible per-keystroke bounce.
    if (Math.abs(el.scrollTop - top) > 1) {
      el.scrollTop = top;
    }
  }, []);

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

  const handleScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
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
    if (reachedBottom || (movedTowardBottomAfterUserIntent && decision.pinToBottom)) {
      isFollowingRef.current = true;
      clearUserScrollIntent();
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    setShowScrollToBottom(decision.showFab);
  }, [clearUserScrollIntent, scrollToFollowTarget]);

  const reconcileScrollAffordance = useCallback((el: HTMLDivElement): void => {
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
    if (isFollowingRef.current) {
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }
    if (decision.distanceFromBottom === 0) {
      isFollowingRef.current = true;
      clearUserScrollIntent();
      scrollToFollowTarget(el, true);
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }
    setShowScrollToBottom(decision.showFab);
  }, [clearUserScrollIntent, scrollToFollowTarget]);

  const scrollToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    isFollowingRef.current = true;
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
    scrollToFollowTarget(el, true);
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, [clearUserScrollIntent, scrollToFollowTarget, sessionId]);

  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el || !isFollowingRef.current) return;
    scrollToFollowTarget(el, true);
  }, [conversationItems, isThinking, scrollToFollowTarget]);

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
