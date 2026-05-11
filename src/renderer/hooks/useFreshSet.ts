import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a predicate `(item) => boolean` that's true the first time `item`
 * has been observed. Useful for one-shot "flash" animations on newly-arrived
 * items. The `resetKey` clears the seen set — pass a session/conversation
 * id so switching contexts re-flashes existing items.
 */
export function useFreshSet<T>(items: T[], getId: (item: T) => string, resetKey: string): (item: T) => boolean {
  const stateRef = useRef<{ key: string; seen: Set<string> }>({ key: "", seen: new Set() });
  if (stateRef.current.key !== resetKey) {
    stateRef.current = { key: resetKey, seen: new Set(items.map(getId)) };
  }
  useEffect(() => {
    for (const item of items) stateRef.current.seen.add(getId(item));
  }, [items, getId]);
  return useCallback((item: T) => !stateRef.current.seen.has(getId(item)), [getId]);
}
