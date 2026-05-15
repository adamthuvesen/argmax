/**
 * User preference for what ⌘N (or the sidebar "new session" button) does when
 * the multi-grid already has at least one active session pane.
 *
 * - `embedded`: insert a launcher cell into the active grid alongside the
 *   running sessions. This is the historical Argmax default — the user can
 *   compose a new task while still watching their other panes.
 * - `full`: hide the grid and show the standalone LaunchSurface as a full
 *   workspace view. After the new session launches, Argmax returns to the
 *   grid with the new pane focused. The grid state is preserved across the
 *   round trip.
 *
 * When the grid is empty, both modes behave identically — the LaunchSurface
 * shows full-screen as it does today.
 *
 * Persisted to localStorage. Reads tolerate missing/corrupt values by
 * returning the safe default.
 */
export type NewSessionMode = "embedded" | "full";

export const NEW_SESSION_MODE_KEY = "argmax.newSessionMode";
export const DEFAULT_NEW_SESSION_MODE: NewSessionMode = "embedded";

export function isNewSessionMode(value: unknown): value is NewSessionMode {
  return value === "embedded" || value === "full";
}

export function readStoredNewSessionMode(): NewSessionMode {
  if (typeof window === "undefined") {
    return DEFAULT_NEW_SESSION_MODE;
  }
  const stored = window.localStorage.getItem(NEW_SESSION_MODE_KEY);
  return isNewSessionMode(stored) ? stored : DEFAULT_NEW_SESSION_MODE;
}
