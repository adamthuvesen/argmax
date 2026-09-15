import { useSyncExternalStore } from "react";

/** Whether transcript activity icons use semantic color or one muted ink. */
type ActivityIconColorMode = "color" | "monochrome";

type ActivityIconColorModeOption = {
  id: ActivityIconColorMode;
  label: string;
  hint: string;
};

export const ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY = "argmax.activityIcons.colorMode";
const DEFAULT_ACTIVITY_ICON_COLOR_MODE: ActivityIconColorMode = "color";

export const ACTIVITY_ICON_COLOR_MODE_OPTIONS: readonly ActivityIconColorModeOption[] = [
  {
    id: "color",
    label: "Color",
    hint: "Use semantic colors to distinguish kinds of work and integration marks."
  },
  {
    id: "monochrome",
    label: "Monochrome",
    hint: "Render transcript activity icons and integration marks in one muted ink."
  }
] as const;

export function isActivityIconColorMode(value: unknown): value is ActivityIconColorMode {
  return value === "color" || value === "monochrome";
}

function storedActivityIconColorMode(): ActivityIconColorMode {
  if (typeof window === "undefined") return DEFAULT_ACTIVITY_ICON_COLOR_MODE;
  try {
    const raw = window.localStorage.getItem(ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY);
    if (isActivityIconColorMode(raw)) return raw;
  } catch {
    // localStorage can throw in sandboxed contexts; fall through to the default.
  }
  return DEFAULT_ACTIVITY_ICON_COLOR_MODE;
}

let state: ActivityIconColorMode | null = null;
const listeners = new Set<() => void>();

function applyActivityIconColorModeToDocument(mode: ActivityIconColorMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.activityIconColor = mode;
}

export function setActivityIconColorMode(mode: ActivityIconColorMode): void {
  if (state === mode) return;
  state = mode;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(ACTIVITY_ICON_COLOR_MODE_STORAGE_KEY, mode);
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }
  applyActivityIconColorModeToDocument(mode);
  for (const listener of listeners) listener();
}

function subscribeActivityIconColorMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
export function activityIconColorModeSnapshot(): ActivityIconColorMode {
  state ??= storedActivityIconColorMode();
  return state;
}

export function useActivityIconColorMode(): ActivityIconColorMode {
  return useSyncExternalStore(
    subscribeActivityIconColorMode,
    activityIconColorModeSnapshot,
    activityIconColorModeSnapshot
  );
}

/** Restore the persisted choice before the first transcript icon paints. */
export function initActivityIconColorMode(): void {
  applyActivityIconColorModeToDocument(activityIconColorModeSnapshot());
}

/** Re-read the persisted choice after a test changes localStorage. */
export function resetActivityIconColorModeForTests(): void {
  state = null;
  for (const listener of listeners) listener();
}
