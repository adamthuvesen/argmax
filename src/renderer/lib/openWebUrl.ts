import { openInBrowserPanel } from "./browserPanel.js";
import { readStoredLinkTarget } from "./linkTarget.js";
import { isSecondaryWindow } from "./windowRole.js";

/**
 * Open an http(s) URL the same way a chat link would: Settings → General
 * "Web links from chat", flipped by ⌘/Ctrl.
 */
export function openWebUrl(url: string, options?: { flip?: boolean }): void {
  const flip = options?.flip === true;
  // A torn-off window has no browser surface to open into; the system
  // browser takes the link there (docs/browser.md).
  if (!isSecondaryWindow() && (readStoredLinkTarget() === "argmax") !== flip) {
    openInBrowserPanel(url, { newTab: true });
    return;
  }
  if (!window.argmax) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void window.argmax.system.openPath({ path: url }).catch(() => undefined);
}
