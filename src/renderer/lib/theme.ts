/**
 * Theme system — three modes (Light, Dark, System).
 *
 * Mirrors the font picker pattern in `lib/fonts.ts`:
 * - User picks a mode from Settings → Appearance.
 * - Persisted to localStorage under `argmax.theme.mode`.
 * - Applied as a `data-theme` attribute on `<html>`, which flips the token
 *   block in `styles.css` (`:root[data-theme="dark"]`).
 * - When mode is `"system"`, the resolved value follows
 *   `prefers-color-scheme`, and updates live when the OS preference flips.
 *
 * Tauri runtime keeps its own cached copy in `userData/theme.json` so
 * `BrowserWindow.backgroundColor` matches at cold start (no white flash). The
 * renderer notifies main via `system:setTheme` IPC on every change.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "argmax.theme.mode";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

const THEME_MODES = new Set<string>(["light", "dark", "system"]);

export type ThemeOption = {
  id: ThemeMode;
  label: string;
  hint: string;
};

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "system",
    label: "System",
    hint: "Follow macOS — switches with your OS appearance setting."
  },
  {
    id: "light",
    label: "Light",
    hint: "Paper. Warm off-white with subtle pulp grain."
  },
  {
    id: "dark",
    label: "Dark",
    hint: "Warm charcoal. Yellow-leaning grays, never midnight blue."
  }
] as const;

export function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME_MODE;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && THEME_MODES.has(raw)) return raw as ThemeMode;
  } catch {
    // localStorage can throw in some sandboxed contexts; fall through.
  }
  return DEFAULT_THEME_MODE;
}

export function writeStoredTheme(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

export function prefersDarkSystem(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean = prefersDarkSystem()): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/**
 * Set the `data-theme` attribute on the document root. The attribute is
 * always one of `"light" | "dark"` (never `"system"`) — resolution to the
 * concrete value happens here, so CSS selectors only ever see a final answer.
 */
export function applyThemeToDocument(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

/**
 * Add a one-frame `theme-transition` class on the root so the CSS crossfade
 * rule kicks in for exactly one theme swap. Without this, every hover would
 * animate background-color and trash scroll performance.
 */
export function animateThemeChange(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.add("theme-transition");
  // 240ms covers the 220ms transition + a frame of slack. Using setTimeout
  // rather than transitionend because the listener would fire per-property
  // per-element and we only want one removal.
  window.setTimeout(() => {
    root.classList.remove("theme-transition");
  }, 240);
}

export function getThemeOption(id: ThemeMode): ThemeOption {
  return THEME_OPTIONS.find((option) => option.id === id) ?? THEME_OPTIONS[0];
}

/**
 * Subscribe a callback to data-theme attribute changes. Returns an unsubscribe.
 * Consumers that read the document attribute imperatively (xterm, shiki) use
 * this to refresh their styling when the user toggles theme in Settings or
 * the OS preference flips under "System".
 */
export function subscribeToThemeChange(cb: (resolved: ResolvedTheme) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    cb(attr === "dark" ? "dark" : "light");
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });
  return () => observer.disconnect();
}

/** Read the *resolved* theme from the document — never returns "system". */
export function readResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
