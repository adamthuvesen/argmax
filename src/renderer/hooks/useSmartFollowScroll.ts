import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { decideSmartFollow, NEAR_BOTTOM_PX } from "../lib/smartFollow.js";

const FOLLOW_SPRING_DAMPING = 0.7;
const FOLLOW_SPRING_STIFFNESS = 0.05;
const FOLLOW_SPRING_MASS = 1.25;
const FOLLOW_FRAME_MS = 1000 / 60;
const FOLLOW_MAX_FRAME_DELTA = 4;
const FOLLOW_RETAIN_MS = 350;
const FOLLOW_SETTLE_PX = 0.75;
const FOLLOW_MIN_STEP_PX = 1;

interface FollowAnimation {
  frameId: number | null;
  lastTick: number | null;
  retainUntil: number;
  velocity: number;
}

export interface SmartFollowScroll {
  /** Attach to the scrollable conversation list `<div>`. */
  conversationListRef: RefObject<HTMLDivElement | null>;
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
 * - When the scroll viewport resizes (the composer grows as the user types, the
 *   meta-cards row changes, a panel opens), follow if the reader was at the
 *   latest line *before* the resize. The viewport height changed without any
 *   smart-follow dep changing, and without a scroll event to update state.
 * - When a live assistant bubble grows inside an existing item, re-run follow:
 *   smooth text reveal updates DOM height without changing `conversationItems`.
 * - One retained spring owns every programmatic move. Streaming growth,
 *   viewport changes, child resizes, and the scroll-to-latest action update the
 *   same moving target instead of cancelling or reversing one another.
 * - Programmatic scroll events do not pause following. Only real user scroll
 *   intent does.
 * - The list keeps a constant bottom padding (idle and live alike) so the
 *   newest streamed line never jams against the edge. It's deliberately not
 *   toggled on live turns: a gap that only appeared while streaming would be
 *   reclaimed the instant the turn ended, jerking the view up as the last
 *   line settled.
 *
 * `now` is intentionally NOT in the deps of the pin effect — re-scrolling
 * every 250 ms while a tool runs would be jittery.
 *
 * Item changes schedule their target in `useLayoutEffect`, before the browser
 * paints the new content. Session changes still snap in that phase so one
 * session never inherits another session's scroll position.
 */
export function useSmartFollowScroll(
  sessionId: string | null | undefined,
  conversationItems: readonly unknown[],
  isThinking: boolean,
  liveFollow = false,
  /** The composer's textarea. It is what grows as the user types, and that
   *  growth is what takes height from the list. Observing it directly means
   *  the re-pin never waits on the viewport's own resize notification. */
  composerRef?: RefObject<HTMLElement | null>
): SmartFollowScroll {
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);
  const lastViewportHeightRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<boolean>(false);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  const lastSeenItemCountRef = useRef<number>(0);
  const liveFollowRef = useRef(liveFollow);
  const followAnimationRef = useRef<FollowAnimation>({
    frameId: null,
    lastTick: null,
    retainUntil: 0,
    velocity: 0
  });
  liveFollowRef.current = liveFollow;

  const prefersReducedMotion = useCallback((): boolean => {
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const cancelFollowAnimation = useCallback((): void => {
    const animation = followAnimationRef.current;
    if (animation.frameId !== null) {
      window.cancelAnimationFrame(animation.frameId);
    }
    animation.frameId = null;
    animation.lastTick = null;
    animation.retainUntil = 0;
    animation.velocity = 0;
  }, []);

  const animateFollowToBottom = useCallback((el: HTMLDivElement, retain: boolean): void => {
    const animation = followAnimationRef.current;
    const now = performance.now();
    if (retain) {
      animation.retainUntil = Math.max(animation.retainUntil, now + FOLLOW_RETAIN_MS);
    }
    if (animation.frameId !== null) return;

    const tick = (timestamp: number): void => {
      animation.frameId = null;
      if (!wasNearBottomRef.current || userScrollIntentRef.current) return;

      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      const distance = target - el.scrollTop;
      if (distance <= FOLLOW_SETTLE_PX) {
        // Content or viewport shrink can move the physical bottom above the
        // current position. Never turn that into an animated reverse step.
        // Browsers clamp scrollTop to the new maximum as part of layout.
        if (distance >= 0) {
          el.scrollTop = target;
        }
        animation.lastTick = timestamp;
        animation.velocity = 0;
        if (timestamp < animation.retainUntil) {
          animation.frameId = window.requestAnimationFrame(tick);
        } else {
          animation.lastTick = null;
          animation.retainUntil = 0;
        }
        return;
      }

      const previousTick = animation.lastTick ?? timestamp - FOLLOW_FRAME_MS;
      const frameDelta = Math.min(
        FOLLOW_MAX_FRAME_DELTA,
        Math.max(0, (timestamp - previousTick) / FOLLOW_FRAME_MS)
      );
      animation.lastTick = timestamp;
      animation.velocity = (
        FOLLOW_SPRING_DAMPING * animation.velocity + FOLLOW_SPRING_STIFFNESS * distance
      ) / FOLLOW_SPRING_MASS;
      const step = Math.max(FOLLOW_MIN_STEP_PX, animation.velocity * frameDelta);
      const nextTop = Math.min(target, el.scrollTop + step);
      el.scrollTop = target - nextTop <= FOLLOW_SETTLE_PX ? target : nextTop;

      animation.frameId = window.requestAnimationFrame(tick);
    };

    animation.frameId = window.requestAnimationFrame(tick);
  }, []);

  const scrollToFollowTarget = useCallback((
    el: HTMLDivElement,
    options: { force?: boolean; smooth?: boolean; retain?: boolean } = {}
  ): void => {
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);
    if (!options.force && decision.distanceFromBottom <= 0) {
      return;
    }
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (options.smooth && !prefersReducedMotion()) {
      animateFollowToBottom(el, options.retain ?? false);
    } else {
      cancelFollowAnimation();
      el.scrollTop = top;
    }
  }, [animateFollowToBottom, cancelFollowAnimation, prefersReducedMotion]);

  const clearUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = false;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = null;
    }
  }, []);

  const handleUserScrollIntent = useCallback((): void => {
    cancelFollowAnimation();
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== null) {
      window.clearTimeout(userScrollIntentTimerRef.current);
    }
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentTimerRef.current = null;
    }, 350);
  }, [cancelFollowAnimation]);

  const handleScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);

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
  }, [clearUserScrollIntent]);

  const reconcileScrollAffordance = useCallback((el: HTMLDivElement): void => {
    const decision = decideSmartFollow(el.scrollHeight, el.scrollTop, el.clientHeight);

    if (decision.pinToBottom) {
      wasNearBottomRef.current = true;
      clearUserScrollIntent();
      setShowScrollToBottom(false);
      setNewBelowCount(0);
      return;
    }

    if (!wasNearBottomRef.current) {
      setShowScrollToBottom(decision.showFab);
    }
  }, [clearUserScrollIntent]);

  const scrollToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    wasNearBottomRef.current = true;
    scrollToFollowTarget(el, { force: true, smooth: true, retain: liveFollowRef.current });
    setShowScrollToBottom(false);
    setNewBelowCount(0);
  }, [clearUserScrollIntent, scrollToFollowTarget]);

  useEffect(() => clearUserScrollIntent, [clearUserScrollIntent]);
  useEffect(() => cancelFollowAnimation, [cancelFollowAnimation]);

  // Snap to the latest content when the session changes.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    clearUserScrollIntent();
    scrollToFollowTarget(el, { force: true });
    wasNearBottomRef.current = true;
  }, [clearUserScrollIntent, scrollToFollowTarget, sessionId]);

  // Follow output as items / thinking-state change, IF the user is already near
  // the bottom. A live turn retains the spring briefly so rapid deltas update a
  // moving target without restarting the animation.
  useLayoutEffect(() => {
    const el = conversationListRef.current;
    if (!el || !wasNearBottomRef.current) return;
    scrollToFollowTarget(el, { smooth: true, retain: liveFollow });
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

  /**
   * Re-pin after something outside the list changed the viewport under it.
   *
   * The list shares the surface's column with everything below it, so anything
   * that grows down there, such as a draft wrapping onto another line, a queued
   * follow-up, the approvals banner, or a panel, takes height from the scroll
   * viewport without touching scrollHeight or any smart-follow dep, and without
   * firing a scroll event. Left alone, the newest line slides under the
   * composer and stays there until the next delta yanks it back.
   *
   * Whether to follow is decided by where the reader sat *before* the resize,
   * not by `wasNearBottomRef`: a shrinking viewport pushes the latest line down
   * by exactly the height it took, so the pre-resize gap is `distance - shrink`.
   * The sticky flag only updates on scroll events, so a composer growing under
   * a still list can leave it stale in either direction; the measurement can't.
   */
  const pinAfterViewportChange = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const previousHeight = lastViewportHeightRef.current;
    const height = el.clientHeight;
    lastViewportHeightRef.current = height;
    const distanceNow = Math.max(0, el.scrollHeight - el.scrollTop - height);
    const shrunkBy = previousHeight === null ? 0 : Math.max(0, previousHeight - height);
    const distanceBefore = Math.max(0, distanceNow - shrunkBy);
    if (distanceBefore >= NEAR_BOTTOM_PX) {
      reconcileScrollAffordance(el);
      return;
    }
    clearUserScrollIntent();
    wasNearBottomRef.current = true;
    scrollToFollowTarget(el, {
      force: true,
      smooth: true,
      retain: liveFollowRef.current
    });
  }, [clearUserScrollIntent, reconcileScrollAffordance, scrollToFollowTarget]);

  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    lastViewportHeightRef.current = el.clientHeight;
    const observer = new ResizeObserver(pinAfterViewportChange);
    observer.observe(el);
    const composer = composerRef?.current;
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [composerRef, pinAfterViewportChange]);

  // Smooth text reveal grows an existing bubble without adding a new timeline
  // item, so `conversationItems` does not change. Observe direct children so
  // growing assistant turns still get live-follow catch-up.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (wasNearBottomRef.current) {
        scrollToFollowTarget(el, { smooth: true, retain: liveFollowRef.current });
      } else {
        reconcileScrollAffordance(el);
      }
    });
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) {
        observer.observe(child);
      }
    }
    return () => observer.disconnect();
  }, [conversationItems, reconcileScrollAffordance, scrollToFollowTarget]);

  return {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom,
    handleUserScrollIntent,
    handleScroll
  };
}
