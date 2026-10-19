import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, BrowserStateEvent } from "../../shared/types.js";
import { setBrowserHistoryStorageForTests } from "../lib/browserHistory.js";
import {
  applyBrowserTabs,
  createBrowserTab,
  getBrowserTabs,
  requestBrowserTabFocus,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests
} from "../lib/browserPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { useReviewState } from "../hooks/useReviewState.js";

const newTabListeners = new Set<(event: { tabId: string; url: string }) => void>();
const pageCommandListeners = new Set<(event: { tabId: string; command: string }) => void>();
const stateListeners = new Set<(event: BrowserStateEvent) => void>();
const browser = {
  open: vi.fn(() => Promise.resolve({ ok: true as const })),
  setBounds: vi.fn(() => Promise.resolve({ ok: true as const })),
  focus: vi.fn(() => Promise.resolve({ ok: true as const })),
  screenshot: vi.fn(() => Promise.resolve({ pngBase64: "" })),
  close: vi.fn(() => Promise.resolve({ ok: true as const })),
  navigate: vi.fn(() => Promise.resolve({ ok: true as const })),
  reload: vi.fn(() => Promise.resolve({ ok: true as const })),
  back: vi.fn(() => Promise.resolve({ ok: true as const })),
  forward: vi.fn(() => Promise.resolve({ ok: true as const })),
  evaluate: vi.fn(() => Promise.resolve({ resultJson: '{"count":0,"index":0}' })),
  onState: vi.fn((listener: (event: BrowserStateEvent) => void) => {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); };
  }),
  onNewTab: vi.fn((listener: (event: { tabId: string; url: string }) => void) => {
    newTabListeners.add(listener);
    return () => { newTabListeners.delete(listener); };
  }),
  onPageCommand: vi.fn((listener: (event: { tabId: string; command: string }) => void) => {
    pageCommandListeners.add(listener);
    return () => { pageCommandListeners.delete(listener); };
  })
};

beforeEach(() => {
  window.localStorage.clear();
  resetBrowserSurfaceForTests();
  resetBrowserTabsForTests();
  vi.clearAllMocks();
  newTabListeners.clear();
  pageCommandListeners.clear();
  stateListeners.clear();
  setBrowserHistoryStorageForTests({ load: () => Promise.resolve([]), save: () => Promise.resolve() });
  window.argmax = { browser } as unknown as ArgmaxApi;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const x = this.closest('[aria-label="Second browser"]') ? 400 : 0;
    return { x, y: 20, width: 400, height: 300, top: 20, left: x, right: x + 400, bottom: 320, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserSurfaceForTests();
  resetBrowserTabsForTests();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

function emitPageCommand(tabId: string, command: string): void {
  act(() => { for (const listener of pageCommandListeners) listener({ tabId, command }); });
}

describe("controlled browser pages", () => {
  it("positions two pages in one scope independently and hides only the removed page", async () => {
    const first = createBrowserTab("chat", "https://first.example");
    const second = createBrowserTab("chat", "https://second.example");
    const view = render(<>
      <section aria-label="First browser"><BrowserPanel scopeId="chat" url="" controlledTabId={first.id} hideTabStrip isFocused={false} onClose={() => undefined} /></section>
      <section aria-label="Second browser"><BrowserPanel scopeId="chat" url="" controlledTabId={second.id} hideTabStrip onClose={() => undefined} /></section>
    </>);
    await waitFor(() => expect(browser.open).toHaveBeenCalledTimes(2));
    expect(within(screen.getByRole("region", { name: "First browser" })).getByRole("textbox", { name: "Address" })).toHaveValue(first.url);
    expect(within(screen.getByRole("region", { name: "Second browser" })).getByRole("textbox", { name: "Address" })).toHaveValue(second.url);
    expect(screen.queryByRole("tablist", { name: "Browser tabs" })).toBeNull();
    expect(browser.setBounds).toHaveBeenCalledWith({ tabId: first.id, bounds: { x: 0, y: 20, width: 400, height: 300 }, visible: true });
    expect(browser.setBounds).toHaveBeenCalledWith({ tabId: second.id, bounds: { x: 400, y: 20, width: 400, height: 300 }, visible: true });
    expect(browser.focus).not.toHaveBeenCalled();
    browser.setBounds.mockClear();
    view.rerender(<>
      <section aria-label="First browser" />
      <section aria-label="Second browser"><BrowserPanel scopeId="chat" url="" controlledTabId={second.id} hideTabStrip onClose={() => undefined} /></section>
    </>);
    expect(browser.setBounds).toHaveBeenCalledWith(expect.objectContaining({ tabId: first.id, visible: false }));
    expect(browser.setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: second.id, visible: false }));
    expect(browser.close).not.toHaveBeenCalled();
    expect(getBrowserTabs("chat")).toHaveLength(2);
  });

  it("keeps late native opens hidden after unmount without closing the page", async () => {
    let finishOpen: (() => void) | undefined;
    browser.open.mockImplementationOnce(() => new Promise((resolve) => { finishOpen = () => resolve({ ok: true }); }));
    const tab = createBrowserTab("chat", "https://first.example");
    const view = render(<BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} hideTabStrip onClose={() => undefined} />);
    await waitFor(() => expect(browser.open).toHaveBeenCalledTimes(1));
    view.unmount();
    browser.setBounds.mockClear();
    await act(async () => { finishOpen?.(); await Promise.resolve(); });
    expect(browser.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: tab.id, visible: false }));
    expect(browser.focus).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("uses the current pane bounds when an open finishes after ownership moves", async () => {
    let finishOpen: (() => void) | undefined;
    browser.open.mockImplementationOnce(() => new Promise((resolve) => { finishOpen = () => resolve({ ok: true }); }));
    const tab = createBrowserTab("chat", "https://first.example");
    const first = render(<section aria-label="First browser"><BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} hideTabStrip onClose={() => undefined} /></section>);
    await waitFor(() => expect(browser.open).toHaveBeenCalledTimes(1));
    render(<section aria-label="Second browser"><BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} hideTabStrip onClose={() => undefined} /></section>);
    browser.setBounds.mockClear();
    first.unmount();
    expect(browser.setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: tab.id, visible: false }));
    await act(async () => { finishOpen?.(); await Promise.resolve(); });
    expect(browser.setBounds).toHaveBeenLastCalledWith({ tabId: tab.id, bounds: { x: 400, y: 20, width: 400, height: 300 }, visible: true });
  });

  it("routes native commands and popups once to their exact workspace page", async () => {
    const first = createBrowserTab("chat", "https://first.example");
    const second = createBrowserTab("chat", "https://second.example");
    const openFirst = vi.fn();
    const openSecond = vi.fn();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const reopen = vi.fn();
    const cycle = vi.fn();
    render(<>
      <BrowserPanel scopeId="chat" url="" controlledTabId={first.id} hideTabStrip isFocused={false} onOpenTab={openFirst} onCloseTab={closeFirst} onClose={() => undefined} />
      <BrowserPanel scopeId="chat" url="" controlledTabId={second.id} hideTabStrip onOpenTab={openSecond} onCloseTab={closeSecond} onReopenTab={reopen} onCycleTab={cycle} onClose={() => undefined} />
    </>);
    await waitFor(() => expect(browser.open).toHaveBeenCalledTimes(2));
    emitPageCommand(second.id, "new-tab");
    expect(openFirst).not.toHaveBeenCalled();
    expect(openSecond).toHaveBeenCalledTimes(1);
    expect(getBrowserTabs("chat")).toHaveLength(3);
    emitPageCommand(second.id, "close-tab");
    expect(closeSecond).toHaveBeenCalledWith(second.id);
    expect(closeFirst).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    emitPageCommand(second.id, "reopen-tab");
    emitPageCommand(second.id, "next-tab");
    emitPageCommand(second.id, "previous-tab");
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(cycle.mock.calls).toEqual([[1], [-1]]);
    emitPageCommand(first.id, "back");
    expect(browser.back).toHaveBeenCalledWith(first.id);
    await act(async () => { emitPageCommand(first.id, "find"); await Promise.resolve(); });
    expect(browser.evaluate).toHaveBeenCalledWith(expect.objectContaining({ tabId: first.id }));
    act(() => { for (const listener of newTabListeners) listener({ tabId: first.id, url: "https://popup.example" }); });
    expect(openFirst).not.toHaveBeenCalled();
    expect(openSecond).toHaveBeenCalledTimes(1);
    expect(getBrowserTabs("chat")).toHaveLength(4);
    const firstPanel = screen.getAllByRole("group", { name: "Browser" })[0];
    fireEvent.change(within(firstPanel).getByRole("textbox", { name: "Address" }), { target: { value: "https://navigated.example" } });
    fireEvent.keyDown(within(firstPanel).getByRole("textbox", { name: "Address" }), { key: "Enter" });
    expect(browser.navigate).toHaveBeenCalledWith("https://navigated.example", first.id);
  });

  it("retains native new tabs from a hidden page after its panels unmount", () => {
    const first = createBrowserTab("chat", "https://first.example");
    const second = createBrowserTab("chat", "https://second.example");
    const view = render(<>
      <BrowserPanel scopeId="chat" url="" controlledTabId={first.id} hideTabStrip onClose={() => undefined} />
      <BrowserPanel scopeId="chat" url="" controlledTabId={second.id} hideTabStrip onClose={() => undefined} />
    </>);
    view.unmount();
    act(() => { for (const listener of newTabListeners) listener({ tabId: first.id, url: "https://background.example" }); });
    expect(getBrowserTabs("chat").map((tab) => tab.url)).toEqual([first.url, second.url, "https://background.example"]);
  });

  it("focuses an explicitly selected page after its native view opens", async () => {
    let finishOpen: (() => void) | undefined;
    browser.open.mockImplementationOnce(() => new Promise((resolve) => { finishOpen = () => resolve({ ok: true }); }));
    const tab = createBrowserTab("chat", "https://first.example");
    render(<BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} hideTabStrip onClose={() => undefined} />);
    act(() => requestBrowserTabFocus(tab.id));
    expect(browser.focus).not.toHaveBeenCalled();
    await act(async () => { finishOpen?.(); await Promise.resolve(); });
    await waitFor(() => expect(browser.focus).toHaveBeenCalledWith(tab.id));
    browser.focus.mockClear();
    act(() => requestBrowserTabFocus(tab.id));
    await waitFor(() => expect(browser.focus).toHaveBeenCalledWith(tab.id));
  });

  it("focuses and selects the address once for an explicit new-page request", async () => {
    const tab = createBrowserTab("chat", "https://new.example");
    const handled = vi.fn(() => {
      expect(screen.getByRole("textbox", { name: "Address" })).toHaveFocus();
    });
    const view = render(<>
      <input aria-label="Chat composer" />
      <BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} requestTabId={tab.id} requestSeq={7} requestNewTab hideTabStrip onRequestHandled={handled} onClose={() => undefined} />
    </>);
    const address = screen.getByRole("textbox", { name: "Address" });
    await waitFor(() => expect(handled).toHaveBeenCalledWith(7));
    expect(address).toHaveFocus();
    expect(address).toHaveProperty("selectionStart", 0);
    expect(address).toHaveProperty("selectionEnd", tab.url.length);
    expect(screen.queryByRole("button", { name: "Close browser" })).toBeNull();
    screen.getByRole("textbox", { name: "Chat composer" }).focus();
    view.rerender(<>
      <input aria-label="Chat composer" />
      <BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} requestTabId={tab.id} requestSeq={7} requestNewTab hideTabStrip onRequestHandled={handled} panePosition="bottom" onClose={() => undefined} />
    </>);
    expect(screen.getByRole("textbox", { name: "Chat composer" })).toHaveFocus();
    expect(browser.focus).not.toHaveBeenCalled();
  });

  it.each(["shortcut", "new-tab tool"])("opens Claude artifacts from the %s with page focus and no address suggestions", async (entryPoint) => {
    const url = "https://claude.ai/artifacts";
    setBrowserHistoryStorageForTests({
      load: () => Promise.resolve([{ url, title: "Claude", visitedAt: Date.now() }]),
      save: () => Promise.resolve()
    });
    function Artifacts() {
      const review = useReviewState(null, { sessionId: "chat" });
      const tab = review.tabs!.items.find((item) => item.kind === "browser");
      return <>
        <button type="button" onClick={() => {
          if (entryPoint === "shortcut") review.openBrowser(url);
          else review.tabs!.openBrowser(url);
        }}>Claude artifacts</button>
        {tab?.kind === "browser" && <BrowserPanel
          scopeId="chat"
          url={review.browserRequest?.url ?? ""}
          controlledTabId={tab.browserTabId}
          requestTabId={review.browserRequest?.tabId}
          requestSeq={review.browserRequest?.seq}
          requestNewTab={review.browserRequest?.newTab}
          onRequestHandled={review.handleBrowserRequest}
          hideTabStrip
          onClose={review.closePanel}
        />}
      </>;
    }
    render(<Artifacts />);
    fireEvent.click(screen.getByRole("button", { name: "Claude artifacts" }));
    const tab = getBrowserTabs("chat")[0];
    await waitFor(() => expect(browser.focus).toHaveBeenCalledWith(tab.id));
    expect(screen.getByRole("textbox", { name: "Address" })).not.toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "History suggestions" })).not.toBeInTheDocument();
    browser.focus.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Claude artifacts" }));
    await waitFor(() => expect(browser.focus).toHaveBeenCalledWith(tab.id));
    expect(getBrowserTabs("chat")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Address" })).not.toHaveFocus();
  });

  it("routes native new-tab commands to the workspace chooser when provided", async () => {
    const tab = createBrowserTab("chat", "https://first.example");
    const onNewTab = vi.fn();
    const onOpenTab = vi.fn();
    render(<BrowserPanel scopeId="chat" url="" controlledTabId={tab.id} hideTabStrip onNewTab={onNewTab} onOpenTab={onOpenTab} onClose={() => undefined} />);
    await act(async () => { emitPageCommand(tab.id, "new-tab"); await Promise.resolve(); });
    expect(onNewTab).toHaveBeenCalledTimes(1);
    expect(onOpenTab).not.toHaveBeenCalled();
    expect(getBrowserTabs("chat")).toHaveLength(1);
  });

  it("focuses the new address after a native new-tab command and leaves restores unfocused", async () => {
    const first = createBrowserTab("chat", "https://first.example");
    function Pages() {
      const [tabId, setTabId] = useState(first.id);
      return <BrowserPanel scopeId="chat" url="" controlledTabId={tabId} hideTabStrip onOpenTab={setTabId} onClose={() => undefined} />;
    }
    render(<Pages />);
    const address = screen.getByRole("textbox", { name: "Address" });
    expect(address).not.toHaveFocus();
    await act(async () => { emitPageCommand(first.id, "new-tab"); await Promise.resolve(); });
    expect(address).toHaveFocus();
    expect(address).toHaveValue("https://www.google.com");
    expect(address).toHaveProperty("selectionStart", 0);
    expect(address).toHaveProperty("selectionEnd", "https://www.google.com".length);
    expect(browser.focus).not.toHaveBeenCalled();
  });

  it("waits for a requested registry tab without creating another page", async () => {
    render(<BrowserPanel scopeId="chat" url="https://requested.example" controlledTabId="pending-agent" requestNewTab hideTabStrip onClose={() => undefined} />);
    expect(browser.open).not.toHaveBeenCalled();
    expect(getBrowserTabs("chat")).toHaveLength(0);
    act(() => applyBrowserTabs([{ tabId: "pending-agent", ownerSessionId: "chat", url: "https://requested.example", title: "Requested", loading: false, group: null }]));
    await waitFor(() => expect(browser.setBounds).toHaveBeenCalledWith(expect.objectContaining({ tabId: "pending-agent", visible: true })));
    expect(getBrowserTabs("chat")).toHaveLength(1);
    expect(browser.open).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("https://requested.example");
    expect(browser.focus).not.toHaveBeenCalled();
  });
});
