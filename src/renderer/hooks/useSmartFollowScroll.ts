import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { decideSmartFollow } from "../lib/smartFollow.js";

export const LIVE_FOLLOW_RESERVE_PX = 56;
const LIVE_FOLLOW_CATCH_UP_PX = 36;
const LIVE_FOLLOW_EASE = 0.38;
const LIVE_FOLLOW_SETTLE_PX = 0.75;
const LIVE_FOLLOW_MIN_STEP_PX = 1;

export interface SmartFollowScroll {
  /** Attach to the scrollable conversation list `<div>`. */
  conversationListRef: RefObject<HTMLDivElement | null>;
  /** Attach to the meta-cards row above the list. ResizeObserver re-pins. */
  metaCardsRef: RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled away from the bottom. */
  showScrollToBottom: boolean;
  /** Count of new items that arrived while scrolled up; resets on catch-up. */
  newBelowCount: number;
  /** Smooth-scroll the list to the latest content and clear the new-below counter. */
  scrollToBottom: () => void;
  /** Mark the next scroll as user-driven, so scrolling up pauses auto-follow. */
  handleUserScrollIntent: () => void;
  /** Bind to the list's `onScroll`. */
  handleScroll: () => void;
}

/**
 * Smart-follow scroll for the chat list.
 *
 * Behavior:
 * - If the user is near the latest content, keep following as items arrive
 *   (`pinToBottom` from `decideSmartFollow`).
 * - If they've scrolled up to read, surface a scroll-to-bottom FAB and a
 *   count for its accessible label/title.
 * - When the session changes, snap to the latest content so the previous
 *   session's scroll position doesn't bleed into the new one.
 * - When the meta-cards row resizes (changed files / cost panel grows or
 *   shrinks), re-pin if the user was near the bottom — the viewport height
 *   changed without any smart-follow dep changing.
 * - When a live assistant bubble grows inside an existing item, re-run follow:
 *   smooth text reveal updates DOM height without changing `conversationItems`.
 * - Programmatic scroll events, smooth-scroll catch-up, and browser scroll
 *   anchoring do not pause following. Only real user scroll intent does.
 * - While a session is live, CSS adds a bottom reserve. The hook still scrolls
 *   to the physical bottom of that padded list; the reserve is only used for
 *   the "near latest" decision so streamed prose can grow before catch-up.
 *
 * `now` is intentionally NOT in the deps of the pin effect — re-scrolling
 * every 250 ms while a tool runs would be jittery.
 *
 * The pin and session-snap run in `useLayoutEffect`, not `useEffect`: the
 * scroll correction has to land in the same frame as the DOM growth it's
 * compensating for. A passive `useEffect` fires *after* the browser paints,
 * so each streaming token paints once at the old scrollTop (content shoved
 * up off the bottom) and again after the snap-down — a visible up/down
 * shimmer. A layout effect mutates scrollTop before paint, so there's only
 * the pinned frame.
 */
export function useSmartFollowScroll(
  sessionId: string | null | undefined,
  conversationItems: readonly unknown[],
  isThinking: boolean,
  liveFollow = false
): SmartFollowScroll {
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const metaCardsRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);
  const userScrollIntentRef = useRef<boolean>(false);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const lastSeenItemCountRef = useRef<number>(0);
  const liveFollowRef = useRef(liveFollow);
  const liveFollowFrameRef = useRef<number | null>(null);
  liveFollowRef.current = liveFollow;

  const followOffsetFor = useCallback((el: HTMLDivElement): number => {
    return liveFollowRef.current && el.scrollHeight > el.clientHeight
      ? LIVE_FOLLOW_RESERVE_PX
      : 0;
  }, []);

  const prefersReducedMotion = useCallback((): boolean => {
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const cancelLiveFollowAnimation = useCallback((): void => {
    if (liveFollowFrameRef.current === null) return;
    window.cancelAnimationFrame(liveFollowFrameRef.current);
    liveFollowFrameRef.current = null;
  }, []);

  const animateLiveFollowToBottom = useCallback((el: HTMLDivElement): void => {
    if (liveFollowFrameRef.current !== null) return;

    const tick = (): void => {
      liveFollowFrameRef.current = null;
      if (!wasNearBottomRef.current || userScrollIntentRef.current) return;

      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      const distance = target - el.scrollTop;
      if (distance <= LIVE_FOLLOW_SETTLE_PX) {
        el.scrollTop = target;
        return;
      }

      const step = Math.max(LIVE_FOLLOW_MIN_STEP_PX, distance * LIVE_FOLLOW_EASE);
      const nextTop = Math.min(target, el.scrollTop + step);
      el.scrollTop = target - nextTop <= LIVE_FOLLOW_SETTLE_PX ? target : nextTop;

      if (target - el.scrollTop > LIVE_FOLLOW_SETTLE_PX) {
        liveFollowFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    liveFollowFrameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const scrollToFollowTarget = useCallback((
    el: HTMLDivElement,
    options: { force?: boolean; smooth?: boolean; live?: boolean } = {}
  ): void => {
    const followOffset = followOffsetFor(el);
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight, followOffset);
    const rawDistanceFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    const catchUpThreshold = followOffset > 0 ? LIVE_FOLLOW_CATCH_UP_PX : 0;
    const catchUpDistance = followOffset > 0 ? rawDistanceFromBottom : decision.distanceFromBottom;
    if (!options.force && catchUpDistance <= catchUpThreshold) {
      return;
    }
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (options.live && options.smooth && !prefersReducedMotion()) {
      animateLiveFollowToBottom(el);
    } else if (options.smooth && !prefersReducedMotion()) {
      cancelLiveFollowAnimation();
      el.scrollTo({ top, behavior: "smooth" });
    } else {
      cancelLiveFollowAnimation();
      el.scrollTop = top;
    }
  }, [animateLiveFollowToBottom, cancelLiveFollowAnimation, followOffsetFor, prefersReducedMotion]);

  const clearUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = false;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = null;
    }
  }, []);

  const handleUserScrollIntent = useCallback((): void => {
    cancelLiveFollowAnimation();
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
    }
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentTimerRef.current = null;
    }, 350);
  }, [cancelLiveFollowAnimation]);

  const handleScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const decision = decideSmartFollow(
      el.scrollHeight,
      el.scrollTop,
      el.clientHeight,
      followOffsetFor(el)
    );

    if (decision.pinToBottom) {
      wasNearBottomRef.current = true;
      clearUserScrollIntent();
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    if (userScrollIntentRef.current) {
      wasNearBottomRef.current = false;
      setShowScrollToBottom(decision.showFab);
      return;
    }

    if (wasNearBottomRef.current) {
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    setShowScrollToBottom(decision.showFab);
  }, [clearUserScrollIntent, followOffsetFor]);

  const scrollToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    wasNearBottomRef.current = true;
    scrollToFollowTarget(el, { force: true, smooth: true });
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, [clearUserScrollIntent, scrollToFollowTarget]);

  useEffect(() => clearUserScrollIntent, [clearUserScrollIntent]);
  useEffect(() => cancelLiveFollowAnimation, [cancelLiveFollowAnimation]);

  // Snap to the latest content when the session changes.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    scrollToFollowTarget(el, { force: true });
    wasNearBottomRef.current = true;
  }, [clearUserScrollIntent, liveFollow, scrollToFollowTarget, sessionId]);

  // Follow live output as items / thinking-state change, IF the user is already
  // near the bottom. During live turns, let text use the bottom reserve before
  // catching up, which avoids a scroll nudge for every streamed line.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el || !wasNearBottomRef.current) return;
    scrollToFollowTarget(el, { smooth: liveFollow, live: liveFollow });
  }, [conversationItems, isThinking, liveFollow, scrollToFollowTarget]);

  // Count new items while scrolled up. Reset when the user catches up (the
  // scroll handler flips showScrollToBottom false) or taps the FAB.
  useEffect(() => {
    const current = conversationItems.length;
    const previous = lastSeenItemCountRef.current;
    lastSeenItemCountRef.current = current;
    if (showScrollToBottom && current > previous) {
      setNewBelowCount((n) => n + (current - previous));
    }
  }, [conversationItems, showScrollToBottom]);

  // Reset the counter on session change; the delta-tracking effect above
  // picks up the new length on its next run.
  useEffect(() => {
    lastSeenItemCountRef.current = Number.POSITIVE_INFINITY;
    setNewBelowCount(0);
  }, [sessionId]);

  // The meta-cards row shares vertical space with the list via grid 1fr.
  // When it grows/shrinks, the list's viewport changes height without any
  // of the smart-follow deps changing. Re-pin if the user was near bottom.
  useEffect(() => {
    const cards = metaCardsRef.current;
    if (!cards || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!wasNearBottomRef.current) return;
      const el = conversationListRef.current;
      if (!el) return;
      scrollToFollowTarget(el, { force: true });
    });
    observer.observe(cards);
    return () => observer.disconnect();
  }, [scrollToFollowTarget]);

  // Smooth text reveal grows an existing bubble without adding a new timeline
  // item, so `conversationItems` does not change. Observe direct children so
  // growing assistant turns still get live-follow catch-up.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!wasNearBottomRef.current) return;
      scrollToFollowTarget(el, { smooth: liveFollowRef.current, live: liveFollowRef.current });
    });
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) {
        observer.observe(child);
      }
    }
    return () => observer.disconnect();
  }, [conversationItems, scrollToFollowTarget]);

  return {
    conversationListRef,
    metaCardsRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleUserScrollIntent,
    handleScroll
  };
}
