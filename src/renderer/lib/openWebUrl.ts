import { openInBrowserPanel } from "./browserPanel.js";
import { readStoredLinkTarget } from "./linkTarget.js";
import { isRemoteBridge } from "./tauriBridge.js";

/**
 * Open an http(s) URL the same way a chat link would: Settings → General
 * "Web links from chat", flipped by ⌘/Ctrl. The remote bridge has neither
 * the in-app browser nor `system:open-path` on the reader's device, so it
 * falls through to `window.open`.
 */
export function openWebUrl(url: string, options?: { flip?: boolean }): void {
  if (isRemoteBridge()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const flip = options?.flip === true;
  if ((readStoredLinkTarget() === "argmax") !== flip) {
    openInBrowserPanel(url, { newTab: true });
    return;
  }
  if (!window.argmax) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void window.argmax.system.openPath({ path: url }).catch(() => undefined);
}
