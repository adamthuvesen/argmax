import { useEffect, useRef, useSyncExternalStore } from "react";
import { activateBrowserTab, getBrowserRequest, subscribeBrowserRequest } from "../lib/browserPanel.js";
import { readStoredLinkTarget } from "../lib/linkTarget.js";
import { isRemoteBridge } from "../lib/tauriBridge.js";

/**
 * Standalone pages (Usage, Settings, Schedule) replace the chat grid, so no
 * review panel claims `openInBrowserPanel` requests. Route those links here:
 * in-app browser → full-workspace Browser page; system browser → open-path.
 */
export function useStandaloneBrowserLinks(options: {
  active: boolean;
  onOpenInAppBrowser: (url: string) => void;
}): void {
  const pendingBrowserRequest = useSyncExternalStore(subscribeBrowserRequest, getBrowserRequest);
  const handledBrowserSeq = useRef(pendingBrowserRequest?.seq ?? 0);
  const { active, onOpenInAppBrowser } = options;

  useEffect(() => {
    if (!pendingBrowserRequest || pendingBrowserRequest.seq === handledBrowserSeq.current) return;
    // Track the sequence even while no standalone page is showing: a request a
    // review panel already handled must not be replayed the moment Settings
    // opens, which would swap the page the user asked for with the browser.
    handledBrowserSeq.current = pendingBrowserRequest.seq;
    if (!active) return;
    if (isRemoteBridge()) return;

    const url = pendingBrowserRequest.url;
    if (pendingBrowserRequest.tabId || readStoredLinkTarget() === "argmax") {
      if (pendingBrowserRequest.tabId) activateBrowserTab(pendingBrowserRequest.tabId);
      onOpenInAppBrowser(url);
      return;
    }
    if (window.argmax) {
      void window.argmax.system.openPath({ path: url }).catch(() => undefined);
    }
  }, [active, onOpenInAppBrowser, pendingBrowserRequest]);
}
