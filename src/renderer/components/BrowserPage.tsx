import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type JSX } from "react";
import {
  BROWSER_PAGE_OWNER_ID,
  claimBrowserSurface,
  DEFAULT_BROWSER_URL,
  ensureBrowserTabSync,
  getBrowserOwnerId,
  getBrowserRequest,
  lastBrowsedUrl,
  releaseBrowserSurface,
  subscribeBrowserOwner
} from "../lib/browserPanel.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { BrowserPanel } from "./BrowserPanel.js";

/**
 * Full-workspace browser: the same native surface the review panel hosts,
 * without Changes / Files / Terminal chrome. The session sidebar stays up
 * so a chat click leaves this page.
 */
export function BrowserPage({ onClose }: { onClose: () => void }): JSX.Element {
  const ownerId = useSyncExternalStore(subscribeBrowserOwner, getBrowserOwnerId);
  const browserOwner = ownerId === BROWSER_PAGE_OWNER_ID;
  const [request, setRequest] = useState(() => {
    const pending = getBrowserRequest();
    return {
      url: pending?.url || lastBrowsedUrl(BROWSER_PAGE_OWNER_ID),
      seq: pending?.seq ?? 1,
      tabId: pending?.tabId,
      newTab: pending?.newTab
    };
  });

  useLayoutEffect(() => {
    claimBrowserSurface(BROWSER_PAGE_OWNER_ID);
    return () => releaseBrowserSurface(BROWSER_PAGE_OWNER_ID);
  }, []);

  useEffect(() => ensureBrowserTabSync(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const showHere = useCallback((): void => {
    claimBrowserSurface(BROWSER_PAGE_OWNER_ID);
    setRequest((current) => ({
      url: lastBrowsedUrl(BROWSER_PAGE_OWNER_ID),
      seq: current.seq + 1,
      tabId: undefined,
      newTab: undefined
    }));
  }, []);

  return (
    <section className="browser-page" aria-label="Browser">
      {browserOwner ? (
        <BrowserPanel
          scopeId={BROWSER_PAGE_OWNER_ID}
          url={request.url || DEFAULT_BROWSER_URL}
          requestSeq={request.seq}
          requestTabId={request.tabId}
          requestNewTab={request.newTab}
          onClose={onClose}
        />
      ) : (
        <div className="review-empty">
          <span className="review-empty-mark" aria-hidden="true">
            ↗
          </span>
          <span>The browser moved to another pane.</span>
          <button type="button" className="review-empty-action" onClick={showHere}>
            Show here
          </button>
        </div>
      )}
    </section>
  );
}
