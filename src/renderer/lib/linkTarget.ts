/**
 * Where a plain click on a web link in chat opens.
 *
 * - `system`: the OS default browser (the webview's `target="_blank"`
 *   handling). This is the default.
 * - `argmax`: the review panel's Browser view.
 *
 * ⌘/Ctrl-click always opens in the other target, whichever is default.
 * Persisted to localStorage. Reads tolerate missing/corrupt values by
 * returning the default.
 */
export type LinkTarget = "system" | "argmax";

export const LINK_TARGET_KEY = "argmax.links.target";
export const DEFAULT_LINK_TARGET: LinkTarget = "system";

export function isLinkTarget(value: unknown): value is LinkTarget {
  return value === "system" || value === "argmax";
}

export function readStoredLinkTarget(): LinkTarget {
  if (typeof window === "undefined") return DEFAULT_LINK_TARGET;
  const stored = window.localStorage.getItem(LINK_TARGET_KEY);
  return isLinkTarget(stored) ? stored : DEFAULT_LINK_TARGET;
}

export function persistLinkTarget(target: LinkTarget): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LINK_TARGET_KEY, target);
}
