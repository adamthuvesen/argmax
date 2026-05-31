import { useMemo, useRef } from "react";

/**
 * Filters `items` by `predicate`, but returns the *previous* array reference
 * when the filtered result is shallow-equal (same elements, same order) to the
 * last one. The snapshot merge preserves element identity for unchanged rows,
 * so a `dashboard:delta` that only touches another session yields an
 * identity-equal slice here — letting downstream memos and memoized children
 * skip work instead of re-deriving on every unrelated delta.
 *
 * `key` is the explicit recompute trigger (e.g. the session id): the inline
 * `predicate` is recreated each render and intentionally not a dependency, so
 * `key` must capture everything the predicate depends on. When `key` is falsy
 * the unfiltered `items` array is returned (and its reference passes through).
 */
export function useStableFilter<T>(
  items: T[],
  key: string | null,
  predicate: (item: T) => boolean
): T[] {
  const prevRef = useRef<T[]>([]);
  return useMemo(() => {
    if (!key) return items;
    const next = items.filter(predicate);
    const prev = prevRef.current;
    if (prev.length === next.length && prev.every((item, index) => item === next[index])) {
      return prev;
    }
    prevRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- predicate is recreated each render; `key` gates recomputation
  }, [items, key]);
}
