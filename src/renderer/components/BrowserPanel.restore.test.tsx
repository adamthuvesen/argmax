import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { useReviewState } from "../hooks/useReviewState.js";
import {
  applyBrowserTabs,
  getActiveBrowserTabId,
  getBrowserTabs,
  openInBrowserPanel,
  requestAgentBrowserOpen,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests
} from "../lib/browserPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";

function ChatBrowser({ visible }: { visible: boolean }) {
  const review = useReviewState(null, null, { sessionId: "session-a", claimsBrowserRequests: true });
  return visible && review.browserRequest ? (
    <StrictMode>
      <BrowserPanel
        scopeId={review.browserScopeId}
        url={review.browserRequest.url}
        requestSeq={review.browserRequest.seq}
        requestTabId={review.browserRequest.tabId}
        requestNewTab={review.browserRequest.newTab}
        onRequestHandled={review.handleBrowserRequest}
        onClose={review.closePanel}
      />
    </StrictMode>
  ) : null;
}

beforeEach(() => {
  window.localStorage.clear();
  resetBrowserSurfaceForTests();
  resetBrowserTabsForTests();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600,
    top: 0, left: 0, right: 800, bottom: 600,
    toJSON: () => ({})
  });
  const ok = () => vi.fn().mockResolvedValue({ ok: true });
  window.argmax = {
    browser: {
      open: ok(),
      navigate: ok(),
      setBounds: ok(),
      focus: ok(),
      close: ok(),
      onState: () => () => undefined,
      onNewTab: () => () => undefined,
      onPageCommand: () => () => undefined
    },
    review: { listChangedFiles: vi.fn().mockResolvedValue([]), loadDiff: vi.fn().mockResolvedValue(null) },
    workspace: { listFiles: vi.fn().mockResolvedValue([]) }
  } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserSurfaceForTests();
  resetBrowserTabsForTests();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

it.each(["agent", "link"])("restores the selected tab after leaving a chat with a handled %s request", (kind) => {
  const view = render(<ChatBrowser visible />);
  act(() => openInBrowserPanel("https://first.example", { newTab: true }));
  const first = getActiveBrowserTabId("session-a");
  if (kind === "agent") {
    act(() => applyBrowserTabs([{
      tabId: "agent-last",
      ownerSessionId: "session-a",
      url: "https://last.example",
      title: "Last",
      loading: false,
      group: null
    }]));
    act(() => requestAgentBrowserOpen("session-a", "agent-last", "https://last.example"));
  } else {
    act(() => openInBrowserPanel("https://last.example", { newTab: true }));
  }
  fireEvent.click(screen.getByRole("button", { name: "first.example" }));
  const count = getBrowserTabs("session-a").length;
  view.rerender(<ChatBrowser visible={false} />);
  expect(getActiveBrowserTabId("session-a")).toBe(first);
  vi.mocked(window.argmax!.browser.navigate).mockClear();
  vi.mocked(window.argmax!.browser.setBounds).mockClear();
  view.rerender(<ChatBrowser visible />);
  expect(getActiveBrowserTabId("session-a")).toBe(first);
  expect(getBrowserTabs("session-a")).toHaveLength(count);
  expect(screen.getByRole("tab", { name: /first.example/ })).toHaveAttribute("aria-selected", "true");
  expect(window.argmax!.browser.navigate).not.toHaveBeenCalled();
  expect(window.argmax!.browser.setBounds).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: first, visible: true })
  );
  act(() => openInBrowserPanel("https://last.example", { newTab: true }));
  expect(getActiveBrowserTabId("session-a")).not.toBe(first);
  expect(getBrowserTabs("session-a")).toHaveLength(count + 1);
});
