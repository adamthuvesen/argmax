import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a predicate `(item) => boolean` that's true the first time `item`
 * has been observed. Useful for one-shot "flash" animations on newly-arrived
 * items. The `resetKey` clears the seen set — pass a session/conversation
 * id so switching contexts re-flashes existing items.
 */
export function useFreshSet<T>(items: T[], getId: (item: T) => string, resetKey: string): (item: T) => boolean {
  const seenRef = useRef<Set<string>>(new Set());
  const keyRef = useRef<string | null>(null);
  // Render is pure — no ref mutation here. The effect handles both the
  // resetKey transition (seed seen with current items) and incremental
  // additions on subsequent renders with the same key.
  useEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      seenRef.current = new Set(items.map(getId));
      return;
    }
    for (const item of items) seenRef.current.add(getId(item));
  }, [items, getId, resetKey]);
  return useCallback(
    (item: T) => {
      // During the render where resetKey just changed (before the effect
      // commits the reseed), report every item as fresh so the docstring
      // contract — "switching contexts re-flashes existing items" — holds.
      if (keyRef.current !== resetKey) return true;
      return !seenRef.current.has(getId(item));
    },
    [getId, resetKey]
  );
}
