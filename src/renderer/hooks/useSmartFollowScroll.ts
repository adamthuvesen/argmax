import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { decideSmartFollow } from "../lib/smartFollow.js";

export interface SmartFollowScroll {
  /** Attach to the scrollable conversation list `<div>`. */
  conversationListRef: RefObject<HTMLDivElement | null>;
  /** Attach to the meta-cards row above the list. ResizeObserver re-pins. */
  metaCardsRef: RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled away from the bottom. */
  showScrollToBottom: boolean;
  /** Count of new items that arrived while scrolled up; resets on catch-up. */
  newBelowCount: number;
  /** Smooth-scroll the list to its bottom and clear the new-below counter. */
  scrollToBottom: () => void;
  /** Bind to the list's `onScroll`. */
  handleScroll: () => void;
}

/**
 * Smart-follow scroll for the chat list.
 *
 * Behavior:
 * - If the user is near the bottom, keep them pinned as items arrive
 *   (`pinToBottom` from `decideSmartFollow`).
 * - If they've scrolled up to read, surface a scroll-to-bottom FAB and a
 *   count for its accessible label/title.
 * - When the session changes, snap to the latest content so the previous
 *   session's scroll position doesn't bleed into the new one.
 * - When the meta-cards row resizes (changed files / cost panel grows or
 *   shrinks), re-pin if the user was near the bottom — the viewport height
 *   changed without any smart-follow dep changing.
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
  isThinking: boolean
): SmartFollowScroll {
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const metaCardsRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const lastSeenItemCountRef = useRef<number>(0);

  const handleScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
    wasNearBottomRef.current = decision.pinToBottom;
    setShowScrollToBottom(decision.showFab);
    if (!decision.showFab) {
      setNewBelowCount(0);
    }
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewBelowCount(0);
  }, []);

  // Snap to the latest content when the session changes.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasNearBottomRef.current = true;
  }, [sessionId]);

  // Pin to bottom as items / thinking-state change, IF the user is already
  // near the bottom. Otherwise leave their position alone.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el || !wasNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [conversationItems, isThinking]);

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
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(cards);
    return () => observer.disconnect();
  }, []);

  return {
    conversationListRef,
    metaCardsRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleScroll
  };
}
