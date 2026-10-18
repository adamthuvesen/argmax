import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// Floored to the minute so repeated reads inside one render agree, which
// useSyncExternalStore requires of a snapshot.
function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

/** Wall clock that advances once a minute. Every subscriber shares one timer,
 *  so a long sidebar list runs one interval rather than one per row. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, currentMinute);
}
