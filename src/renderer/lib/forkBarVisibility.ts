import { useSyncExternalStore } from "react";

/**
 * Whether a forked chat shows its fork bar — Settings → Appearance → Fork bar.
 *
 * Its own store, like `lib/mascotVisibility.ts`: the bar mounts deep inside
 * `SessionConversation`, and one subscription in `ForkBar` beats threading a
 * prop through every pane and grid that renders a conversation.
 */
export const FORK_BAR_VISIBLE_STORAGE_KEY = "argmax.forkBar.visible";

/** On: hidden, a fork has no other way back to its source. */
const DEFAULT_FORK_BAR_VISIBLE = true;

function storedForkBarVisible(): boolean {
  if (typeof window === "undefined") return DEFAULT_FORK_BAR_VISIBLE;
  try {
    const raw = window.localStorage.getItem(FORK_BAR_VISIBLE_STORAGE_KEY);
    if (raw !== null) return raw === "true";
  } catch {
    // localStorage can throw in sandboxed contexts; fall through to the default.
  }
  return DEFAULT_FORK_BAR_VISIBLE;
}

// Read lazily rather than at import: the module loads before a test has seeded
// localStorage, and the app boots long after.
let state: boolean | null = null;
const listeners = new Set<() => void>();

export function setForkBarVisible(visible: boolean): void {
  if (state === visible) return;
  state = visible;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(FORK_BAR_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }
  for (const listener of listeners) listener();
}

function subscribeForkBarVisible(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
function forkBarVisibleSnapshot(): boolean {
  state ??= storedForkBarVisible();
  return state;
}

export function useForkBarVisible(): boolean {
  return useSyncExternalStore(subscribeForkBarVisible, forkBarVisibleSnapshot, forkBarVisibleSnapshot);
}
