import type { ThemeMode } from "./theme.js";

export const BROWSER_THEME_STORAGE_KEY = "argmax.browser.theme.mode";
const DEFAULT_BROWSER_THEME_MODE: ThemeMode = "system";

const BROWSER_THEME_MODES = new Set<string>(["light", "dark", "system"]);

export function readStoredBrowserTheme(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_BROWSER_THEME_MODE;
  try {
    const raw = window.localStorage.getItem(BROWSER_THEME_STORAGE_KEY);
    if (raw && BROWSER_THEME_MODES.has(raw)) return raw as ThemeMode;
  } catch {
    // localStorage can throw in sandboxed browser previews.
  }
  return DEFAULT_BROWSER_THEME_MODE;
}

export function writeStoredBrowserTheme(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_THEME_STORAGE_KEY, mode);
  } catch {
    // A blocked preference write should not prevent the browser from updating.
  }
}
