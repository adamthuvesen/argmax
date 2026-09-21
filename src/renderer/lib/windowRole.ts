import { getCurrentWindow } from "@tauri-apps/api/window";

// Which desktop window this renderer is. The main window is the one
// tauri.conf.json opens; a chat torn off with "Open in new window" is a
// second window running the same renderer, booted with `?session=<id>` so it
// opens on that chat (src-tauri/src/windows.rs). Outside Tauri — the browser
// preview, the remote bridge, tests — there is only ever the one window.

const MAIN_WINDOW_LABEL = "main";

/**
 * The label Tauri injects before any script runs, or null outside Tauri.
 * Read from the metadata rather than through `getCurrentWindow()` so this
 * module stays importable wherever the bridge is mocked.
 */
export function windowLabelFromRuntime(): string | null {
  if (typeof window === "undefined") return null;
  const internals = window.__TAURI_INTERNALS__ as
    | { metadata?: { currentWindow?: { label?: unknown } } }
    | undefined;
  const label = internals?.metadata?.currentWindow?.label;
  return typeof label === "string" && label.length > 0 ? label : null;
}

export function currentWindowLabel(): string {
  return windowLabelFromRuntime() ?? MAIN_WINDOW_LABEL;
}

/** True in a window torn off from the main one. */
export function isSecondaryWindow(): boolean {
  return currentWindowLabel() !== MAIN_WINDOW_LABEL;
}

/** The session a torn-off window was opened on, read from its URL. */
export function initialSessionIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("session");
  return id && id.length > 0 ? id : null;
}

/** Closes this window. Only a torn-off window closes itself; the main one
 *  stays, as it owns the app's lifetime. */
export function closeCurrentWindow(): void {
  if (windowLabelFromRuntime() === null) return;
  void getCurrentWindow().close();
}
