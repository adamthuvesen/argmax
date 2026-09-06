import { useSyncExternalStore } from "react";

/**
 * Which shape the "this is running right now" mark takes — Settings →
 * Appearance → Activity mark.
 *
 * The mark itself is `components/WorkingNest.tsx`, drawn by
 * `styles/working-nest.css`. All four styles share the same box, the same
 * `--working-nest-lead` / `--working-nest-rest` colours and the same settle
 * behaviour; they differ only in what moves inside.
 *
 * Unlike the other appearance preferences this one carries its own store rather
 * than riding `useLauncherAppearance` props. The mark renders in ~10 places —
 * sidebar rows, tool-call rows, agent tabs, pane headers, the command palette —
 * and each style needs a different number of child elements, so the leaf
 * component has to know the style. Threading a prop through every one of those
 * call sites to reach a decorative glyph is worse than one subscription, and a
 * second copy of the value in React state would be a second source of truth.
 * The settings row reads the same store the marks do.
 *
 * `data-activity-mark` also lands on `<html>`, for anything that wants to key
 * off the choice from a stylesheet alone.
 *
 * The module owns the other half of the same signal too — the sidebar's running
 * underline (below), which is a stylesheet-only effect with no component to
 * hang off. It rides a store here rather than the `useLauncherAppearance` props
 * the other CSS-only preferences use, so that the two halves of one settings
 * group are read the same way.
 */
export type ActivityMarkId = "nest" | "cascade" | "meter" | "orbit";

export type ActivityMarkOption = {
  id: ActivityMarkId;
  label: string;
  hint: string;
};

export const ACTIVITY_MARK_STORAGE_KEY = "argmax.activityMark.style";
export const DEFAULT_ACTIVITY_MARK: ActivityMarkId = "nest";

export const ACTIVITY_MARK_OPTIONS: readonly ActivityMarkOption[] = [
  {
    id: "nest",
    label: "Nest",
    hint: "Four dots in a 2x2, emphasis relaying clockwise. The original — the cluster rearranges rather than blinking."
  },
  {
    id: "cascade",
    label: "Cascade",
    hint: "A wave running down the diagonal of a 3x3 field. The nest's material at higher resolution."
  },
  {
    id: "meter",
    label: "Meter",
    hint: "Three bars on unrelated periods, so the figure never visibly repeats. Reads as throughput rather than waiting."
  },
  {
    id: "orbit",
    label: "Orbit",
    hint: "A comet and its trail on a fixed track. One moving element, so it is the smoothest of the four."
  }
] as const;

/** How many animated parts each style draws, so callers can build the markup. */
export const ACTIVITY_MARK_PART_COUNT: Record<ActivityMarkId, number> = {
  nest: 4,
  cascade: 9,
  meter: 3,
  orbit: 1
};

const ACTIVITY_MARK_IDS = new Set<string>(ACTIVITY_MARK_OPTIONS.map((option) => option.id));

export function isActivityMarkId(value: unknown): value is ActivityMarkId {
  return typeof value === "string" && ACTIVITY_MARK_IDS.has(value);
}

function storedActivityMark(): ActivityMarkId {
  if (typeof window === "undefined") return DEFAULT_ACTIVITY_MARK;
  try {
    const raw = window.localStorage.getItem(ACTIVITY_MARK_STORAGE_KEY);
    if (isActivityMarkId(raw)) return raw;
  } catch {
    // localStorage can throw in sandboxed contexts; fall through to the default.
  }
  return DEFAULT_ACTIVITY_MARK;
}

// Read lazily rather than at import: the module loads before a test has seeded
// localStorage, and the app boots long after.
let state: ActivityMarkId | null = null;
const listeners = new Set<() => void>();

export function applyActivityMarkToDocument(markId: ActivityMarkId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.activityMark = markId;
}

export function setActivityMark(markId: ActivityMarkId): void {
  if (state === markId) return;
  state = markId;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(ACTIVITY_MARK_STORAGE_KEY, markId);
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }
  applyActivityMarkToDocument(markId);
  for (const listener of listeners) listener();
}

export function subscribeActivityMark(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
export function activityMarkSnapshot(): ActivityMarkId {
  state ??= storedActivityMark();
  return state;
}

export function useActivityMark(): ActivityMarkId {
  return useSyncExternalStore(subscribeActivityMark, activityMarkSnapshot, activityMarkSnapshot);
}



/**
 * Whether a running session row draws a light travelling under its text —
 * Settings → Appearance → Running row underline.
 *
 * Two named states rather than a boolean so the stylesheet can key off
 * `<html data-session-underline>` the way it keys off `data-accent`, and so a
 * second flavour of the sweep can be added without migrating the stored value.
 * Off is the default: it is an addition to a surface people already read, and
 * an opt-in flourish should not arrive unannounced.
 */
export type SessionUnderlineId = "off" | "sweep";

export type SessionUnderlineOption = {
  id: SessionUnderlineId;
  label: string;
  hint: string;
};

export const SESSION_UNDERLINE_STORAGE_KEY = "argmax.activityMark.rowUnderline";
export const DEFAULT_SESSION_UNDERLINE: SessionUnderlineId = "off";

export const SESSION_UNDERLINE_OPTIONS: readonly SessionUnderlineOption[] = [
  {
    id: "off",
    label: "Off",
    hint: "A running row is marked by its activity mark alone."
  },
  {
    id: "sweep",
    label: "Sweep",
    hint: "A light crosses under the row's text, the way a caret crosses a line being written. Phased per row, so a column of running sessions reads as flow rather than strobing together."
  }
] as const;

export function isSessionUnderlineId(value: unknown): value is SessionUnderlineId {
  return value === "off" || value === "sweep";
}

function storedSessionUnderline(): SessionUnderlineId {
  if (typeof window === "undefined") return DEFAULT_SESSION_UNDERLINE;
  try {
    const raw = window.localStorage.getItem(SESSION_UNDERLINE_STORAGE_KEY);
    if (isSessionUnderlineId(raw)) return raw;
  } catch {
    // localStorage can throw in sandboxed contexts; fall through to the default.
  }
  return DEFAULT_SESSION_UNDERLINE;
}

let underlineState: SessionUnderlineId | null = null;
const underlineListeners = new Set<() => void>();

export function applySessionUnderlineToDocument(underlineId: SessionUnderlineId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.sessionUnderline = underlineId;
}

export function setSessionUnderline(underlineId: SessionUnderlineId): void {
  if (underlineState === underlineId) return;
  underlineState = underlineId;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SESSION_UNDERLINE_STORAGE_KEY, underlineId);
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }
  applySessionUnderlineToDocument(underlineId);
  for (const listener of underlineListeners) listener();
}

export function subscribeSessionUnderline(listener: () => void): () => void {
  underlineListeners.add(listener);
  return () => {
    underlineListeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
export function sessionUnderlineSnapshot(): SessionUnderlineId {
  underlineState ??= storedSessionUnderline();
  return underlineState;
}

export function useSessionUnderline(): SessionUnderlineId {
  return useSyncExternalStore(
    subscribeSessionUnderline,
    sessionUnderlineSnapshot,
    sessionUnderlineSnapshot
  );
}

/** Push both persisted choices onto `<html>` at boot, before the first paint. */
export function initActivityMark(): void {
  applyActivityMarkToDocument(activityMarkSnapshot());
  applySessionUnderlineToDocument(sessionUnderlineSnapshot());
}

/** Re-reads both persisted choices, so a test can seed them before rendering. */
export function resetActivityMarkForTests(): void {
  state = null;
  underlineState = null;
  for (const listener of listeners) listener();
  for (const listener of underlineListeners) listener();
}
