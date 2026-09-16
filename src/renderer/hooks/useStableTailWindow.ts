import { useEffect, useReducer, useRef, useState } from "react";
import { ALWAYS_FOLLOWING, type TranscriptFollow } from "./useConversationScroll.js";

/**
 * Keep a bounded tail mounted while following live output. Once the reader
 * detaches, retain those exact ids so incoming rows cannot move their place.
 *
 * The follow state is read at render instead of arriving as a prop. A detach
 * needs no render at all, since the mounted ids are already the retained ones,
 * and a return to following renders only a window whose rows went stale.
 */
export function useStableTailWindow<T>(
  items: readonly T[],
  options: {
    initialCount: number;
    pageSize: number;
    follow?: TranscriptFollow;
    getId: (item: T) => string;
  }
): {
  visibleItems: T[];
  hiddenEarlierCount: number;
  showEarlier: () => void;
} {
  const { initialCount, pageSize, follow = ALWAYS_FOLLOWING, getId } = options;
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const detached = follow.isDetached();
  const followingItems = items.slice(-visibleCount);
  const followingIds = followingItems.map(getId);
  const lastFollowingIdsRef = useRef<string[]>(followingIds);
  const detachedIdsRef = useRef<string[] | null>(null);
  if (!detached) {
    lastFollowingIdsRef.current = followingIds;
    detachedIdsRef.current = null;
  }

  const retainedIds = detachedIdsRef.current ?? lastFollowingIdsRef.current;
  const itemById = detached
    ? new Map(items.map((item) => [getId(item), item]))
    : null;
  const visibleItems = itemById
    ? retainedIds.flatMap((id) => {
        const item = itemById.get(id);
        return item ? [item] : [];
      })
    : followingItems;
  const firstVisibleId = visibleItems[0] ? getId(visibleItems[0]) : null;
  const firstVisibleIndex = detached
    ? firstVisibleId
      ? items.findIndex((item) => getId(item) === firstVisibleId)
      : items.length
    : Math.max(0, items.length - followingItems.length);
  const hiddenEarlierCount = Math.max(0, firstVisibleIndex);

  const renderedIdsRef = useRef<string[]>([]);
  const liveIdsRef = useRef<string[]>([]);
  renderedIdsRef.current = visibleItems.map(getId);
  liveIdsRef.current = followingIds;
  useEffect(() => follow.subscribe(() => {
    if (follow.isDetached()) return;
    const rendered = renderedIdsRef.current;
    const live = liveIdsRef.current;
    if (rendered.length !== live.length || rendered.some((id, index) => id !== live[index])) {
      rerender();
    }
  }), [follow]);

  const showEarlier = (): void => {
    if (!detached) {
      setVisibleCount((current) => current + pageSize);
      return;
    }
    const start = Math.max(0, firstVisibleIndex - pageSize);
    const earlierIds = items.slice(start, firstVisibleIndex).map(getId);
    detachedIdsRef.current = [...earlierIds, ...retainedIds];
    rerender();
  };

  return { visibleItems, hiddenEarlierCount, showEarlier };
}
