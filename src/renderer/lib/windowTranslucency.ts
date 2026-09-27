/**
 * Translucent window: the page gives up its paint so macOS's vibrancy behind
 * the transparent window shows through (tauri.conf.json `windowEffects`).
 *
 * The switch lives on <html>, next to data-theme, data-accent and
 * data-background-intensity, so everything that already follows appearance
 * attributes (CSS, xterm, Mermaid) follows this one the same way. What each
 * surface does with it is owned by styles/window-translucency.css.
 */

// Stored under the sidebar names: the setting began as a translucent sidebar
// and kept its keys when it grew to the whole window, so the choice carries over.
export const WINDOW_TRANSLUCENT_KEY = "argmax.sidebar.translucent";
export const WINDOW_TRANSLUCENCY_KEY = "argmax.sidebar.translucency";
export const WINDOW_TRANSLUCENCY_MIN = 10;
export const WINDOW_TRANSLUCENCY_MAX = 60;
export const WINDOW_TRANSLUCENCY_DEFAULT = 30;

export const WINDOW_TRANSLUCENT_ATTRIBUTE = "data-window-translucent";

export function isWindowTranslucent(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute(WINDOW_TRANSLUCENT_ATTRIBUTE) === "true";
}

/** `translucency` is the share of the desktop that shows through, in percent. */
export function applyWindowTranslucencyToDocument(enabled: boolean, translucency: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (enabled) {
    root.setAttribute(WINDOW_TRANSLUCENT_ATTRIBUTE, "true");
    root.style.setProperty("--window-translucency", `${translucency}%`);
  } else {
    root.removeAttribute(WINDOW_TRANSLUCENT_ATTRIBUTE);
    root.style.removeProperty("--window-translucency");
  }
}
