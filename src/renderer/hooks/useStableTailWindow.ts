import { useLayoutEffect, useRef, useState } from "react";

/**
 * Keep a bounded tail mounted while following live output. Once the reader
 * detaches, retain those exact ids so incoming rows cannot move their place.
 */
export function useStableTailWindow<T>(
  items: readonly T[],
  options: {
    initialCount: number;
    pageSize: number;
    detached: boolean;
    getId: (item: T) => string;
  }
): {
  visibleItems: T[];
  hiddenEarlierCount: number;
  showEarlier: () => void;
} {
  const { initialCount, pageSize, detached, getId } = options;
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const followingItems = items.slice(-visibleCount);
  const followingIds = followingItems.map(getId);
  const lastFollowingIdsRef = useRef<string[]>(followingIds);
  if (!detached) lastFollowingIdsRef.current = followingIds;

  const [detachedIds, setDetachedIds] = useState<string[] | null>(null);
  useLayoutEffect(() => {
    if (!detached) {
      setDetachedIds(null);
      return;
    }
    setDetachedIds((current) => current ?? lastFollowingIdsRef.current);
  }, [detached]);

  const retainedIds = detachedIds ?? lastFollowingIdsRef.current;
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

  const showEarlier = (): void => {
    if (!detached) {
      setVisibleCount((current) => current + pageSize);
      return;
    }
    const start = Math.max(0, firstVisibleIndex - pageSize);
    const earlierIds = items.slice(start, firstVisibleIndex).map(getId);
    setDetachedIds((current) => [...earlierIds, ...(current ?? retainedIds)]);
  };

  return { visibleItems, hiddenEarlierCount, showEarlier };
}
