import { useSyncExternalStore } from "react";

/**
 * Whether the fox is drawn at all — Settings → Appearance → Fox mascot.
 *
 * Like the activity mark (see `lib/activityMark.ts`) this rides its own store
 * rather than the `useLauncherAppearance` props the other appearance toggles
 * use: the fox renders from four unrelated places — the launch surface, the
 * sidebar's Argmax chip, the empty state, the mobile new-chat hero — and
 * threading a prop through all of them to reach a decorative mark is worse
 * than one subscription in `Mascot` itself.
 */
export const MASCOT_VISIBLE_STORAGE_KEY = "argmax.mascot.visible";

/** On: the fox is the app's mark, so it ships shown and is opted out of. */
export const DEFAULT_MASCOT_VISIBLE = true;

function storedMascotVisible(): boolean {
  if (typeof window === "undefined") return DEFAULT_MASCOT_VISIBLE;
  try {
    const raw = window.localStorage.getItem(MASCOT_VISIBLE_STORAGE_KEY);
    if (raw !== null) return raw === "true";
  } catch {
    // localStorage can throw in sandboxed contexts; fall through to the default.
  }
  return DEFAULT_MASCOT_VISIBLE;
}

// Read lazily rather than at import: the module loads before a test has seeded
// localStorage, and the app boots long after.
let state: boolean | null = null;
const listeners = new Set<() => void>();

export function setMascotVisible(visible: boolean): void {
  if (state === visible) return;
  state = visible;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(MASCOT_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }
  for (const listener of listeners) listener();
}

function subscribeMascotVisible(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
function mascotVisibleSnapshot(): boolean {
  state ??= storedMascotVisible();
  return state;
}

export function useMascotVisible(): boolean {
  return useSyncExternalStore(subscribeMascotVisible, mascotVisibleSnapshot, mascotVisibleSnapshot);
}

/** Re-reads the persisted choice, so a test can seed it before rendering. */
export function resetMascotVisibilityForTests(): void {
  state = null;
  for (const listener of listeners) listener();
}
