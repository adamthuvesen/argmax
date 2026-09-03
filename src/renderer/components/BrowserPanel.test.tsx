import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, BrowserStateEvent } from "../../shared/types.js";
import { BROWSER_HISTORY_KEY } from "../lib/browserHistory.js";
import {
  applyBrowserTabs,
  getActiveBrowserTabId,
  requestCloseActiveBrowserTab,
  resetBrowserTabsForTests,
  unmarkBrowserTabMaterialized
} from "../lib/browserPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";

let stateListener: ((event: BrowserStateEvent) => void) | null = null;
let newTabListener: ((event: { tabId: string; url: string }) => void) | null = null;
let pageCommandListener: ((event: { tabId: string; command: string }) => void) | null = null;

const browserStub = {
  open: vi.fn(() => Promise.resolve({ ok: true as const })),
  navigate: vi.fn(() => Promise.resolve({ ok: true as const })),
  back: vi.fn(() => Promise.resolve({ ok: true as const })),
  forward: vi.fn(() => Promise.resolve({ ok: true as const })),
  reload: vi.fn(() => Promise.resolve({ ok: true as const })),
  setBounds: vi.fn(() => Promise.resolve({ ok: true as const })),
  close: vi.fn(() => Promise.resolve({ ok: true as const })),
  stop: vi.fn(() => Promise.resolve({ ok: true as const })),
  fillCredentials: vi.fn(() => Promise.resolve({ ok: true, itemTitle: "GitHub" })),
  onState: vi.fn((listener: (event: BrowserStateEvent) => void) => {
    stateListener = listener;
    return () => {
      stateListener = null;
    };
  }),
  onNewTab: vi.fn((listener: (event: { tabId: string; url: string }) => void) => {
    newTabListener = listener;
    return () => {
      newTabListener = null;
    };
  }),
  onPageCommand: vi.fn((listener: (event: { tabId: string; command: string }) => void) => {
    pageCommandListener = listener;
    return () => {
      pageCommandListener = null;
    };
  })
};

function stubRect(element: HTMLElement, rect: { x: number; y: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect
    });
}

/** A window-level overlay at a known box, torn down by `cleanup`'s document reset. */
function appendDialog(rect: { x: number; y: number; width: number; height: number }): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  stubRect(dialog, rect);
  document.body.append(dialog);
  return dialog;
}

function activeTabId(): string {
  const id = getActiveBrowserTabId();
  if (!id) throw new Error("no active browser tab");
  return id;
}

beforeEach(() => {
  stateListener = null;
  newTabListener = null;
  pageCommandListener = null;
  resetBrowserTabsForTests();
  for (const mock of Object.values(browserStub)) mock.mockClear();
  window.argmax = { browser: browserStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
  window.localStorage.removeItem(BROWSER_HISTORY_KEY);
});

describe("BrowserPanel", () => {
  it("creates the first tab's webview for the requested URL", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    expect(browserStub.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com", tabId: activeTabId() })
    );
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("https://github.com");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("github.com");
  });

  it("shows an agent's tab instead of navigating the user's, and badges it", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const userTab = activeTabId();
    browserStub.open.mockClear();
    browserStub.navigate.mockClear();

    // The app opened a tab for a session and pushed the new list.
    act(() =>
      applyBrowserTabs([
        {
          tabId: userTab,
          ownerSessionId: null,
          url: "https://github.com",
          title: null,
          loading: false,
          group: null
        },
        {
          tabId: "agent-1",
          ownerSessionId: "session-a",
          url: "https://example.com",
          title: "Example Domain",
          loading: false,
          group: null
        }
      ])
    );

    expect(screen.getByRole("tab", { name: /Example Domain/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Opened by the agent" })).toBeInTheDocument();

    // Asking for that tab switches to it; the webview already exists, so it is
    // glued in place rather than re-created or navigated.
    act(() => {
      render(
        <BrowserPanel
          url="https://example.com"
          requestSeq={2}
          requestTabId="agent-1"
          onClose={() => undefined}
        />
      );
    });
    expect(getActiveBrowserTabId()).toBe("agent-1");
    expect(browserStub.open).not.toHaveBeenCalled();
    expect(browserStub.navigate).not.toHaveBeenCalled();
  });

  it("shows a session's group label on the tabs it grouped", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const userTab = activeTabId();

    act(() =>
      applyBrowserTabs([
        {
          tabId: userTab,
          ownerSessionId: null,
          url: "https://github.com",
          title: null,
          loading: false,
          group: null
        },
        {
          tabId: "agent-1",
          ownerSessionId: "session-a",
          url: "https://example.com",
          title: "Example Domain",
          loading: false,
          group: "Pricing research"
        }
      ])
    );

    expect(
      screen.getByRole("img", { name: "Opened by the agent, in Pricing research" })
    ).toHaveTextContent("Pricing research");
    // The user's own tab is never grouped, so it carries no chip at all.
    expect(screen.queryByRole("img", { name: "Opened by the agent" })).not.toBeInTheDocument();
  });

  it("navigates on address submit after normalizing the input", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const address = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.submit(address.closest("form") as HTMLFormElement);
    expect(browserStub.navigate).toHaveBeenCalledWith("https://example.com", activeTabId());
  });

  it("turns non-URL address input into a Google search", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const address = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(address, { target: { value: "tauri multiwebview docs" } });
    fireEvent.submit(address.closest("form") as HTMLFormElement);
    expect(browserStub.navigate).toHaveBeenCalledWith(
      "https://www.google.com/search?q=tauri%20multiwebview%20docs",
      activeTabId()
    );
  });

  it("clears the loading spinner on stop and via the watchdog", () => {
    vi.useFakeTimers();
    try {
      render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
      act(() =>
        stateListener?.({ tabId: activeTabId(), url: "https://github.com", title: null, loading: true })
      );

      // Stop: the webview never reports "finished" for an aborted load.
      fireEvent.click(screen.getByRole("button", { name: "Stop loading" }));
      expect(browserStub.stop).toHaveBeenCalledWith(activeTabId());
      expect(screen.queryByRole("button", { name: "Stop loading" })).not.toBeInTheDocument();

      // Watchdog: a load that silently dies stops spinning after the timeout.
      act(() =>
        stateListener?.({ tabId: activeTabId(), url: "https://github.com", title: null, loading: true })
      );
      expect(screen.getByRole("button", { name: "Stop loading" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.queryByRole("button", { name: "Stop loading" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs the address bar from webview navigation events", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    act(() =>
      stateListener?.({ tabId: activeTabId(), url: "https://github.com/argmax", title: "Argmax", loading: false })
    );
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
      "https://github.com/argmax"
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Argmax");
  });

  it("leaves the address bar alone for a background tab's navigation", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    act(() =>
      stateListener?.({ tabId: "not-the-active-tab", url: "https://example.com", title: null, loading: false })
    );
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("https://github.com");
  });

  it("adds a tab, switches back, and closes down to the panel", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://github.com" onClose={onClose} />);
    const firstTab = activeTabId();

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const secondTab = activeTabId();
    expect(secondTab).not.toBe(firstTab);
    expect(browserStub.open).toHaveBeenCalledWith(expect.objectContaining({ tabId: secondTab }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // Switching shows the target tab and hides the previous one.
    fireEvent.click(screen.getByRole("button", { name: "github.com" }));
    expect(activeTabId()).toBe(firstTab);
    expect(browserStub.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: secondTab, visible: false })
    );

    // Closing a tab destroys its webview; closing the last one closes the panel.
    fireEvent.click(screen.getByRole("button", { name: /Close tab.*google/i }));
    expect(browserStub.close).toHaveBeenCalledWith(secondTab);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Close tab github/i }));
    expect(browserStub.close).toHaveBeenCalledWith(firstTab);
    expect(onClose).toHaveBeenCalled();
  });

  it("wires toolbar actions to the bridge and close to the parent", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://github.com" onClose={onClose} />);
    const tab = activeTabId();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
    expect(browserStub.back).toHaveBeenCalledWith(tab);
    expect(browserStub.reload).toHaveBeenCalledWith(tab);
    expect(onClose).toHaveBeenCalled();
  });

  it("suggests visited pages while typing and navigates on pick", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    act(() => stateListener?.({ tabId: activeTabId(), url: "https://github.com", title: "GitHub", loading: false }));
    act(() =>
      stateListener?.({ tabId: activeTabId(), url: "https://example.com/docs", title: "Example Docs", loading: false })
    );

    const address = screen.getByRole("textbox", { name: "Address" });
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: "git" } });

    const popover = screen.getByRole("dialog", { name: "History suggestions" });
    expect(popover).toHaveTextContent("GitHub");
    expect(popover).not.toHaveTextContent("Example Docs");

    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(browserStub.navigate).toHaveBeenCalledWith("https://github.com", activeTabId());
  });

  it("hides the webview only for overlays that reach the surface", async () => {
    // The surface sits in the right-hand column; a session-pane dialog (provider
    // switch, composer popover) opens to its left and must leave the page alive.
    stubRect(document.body, { x: 0, y: 0, width: 1200, height: 800 });
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const surface = document.querySelector(".browser-panel-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("no browser surface");
    stubRect(surface, { x: 800, y: 60, width: 400, height: 740 });

    const paneDialog = appendDialog({ x: 100, y: 200, width: 400, height: 200 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(browserStub.setBounds).not.toHaveBeenCalledWith(
      expect.objectContaining({ visible: false, tabId: activeTabId() })
    );

    paneDialog.remove();
    appendDialog({ x: 300, y: 100, width: 700, height: 600 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(browserStub.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ visible: false, tabId: activeTabId() })
    );
  });

  it("opens a page-requested popup as a new tab", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const firstTab = activeTabId();

    act(() => newTabListener?.({ tabId: firstTab, url: "https://docs.github.com" }));

    const secondTab = activeTabId();
    expect(secondTab).not.toBe(firstTab);
    expect(browserStub.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://docs.github.com", tabId: secondTab })
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("adds a background tab's popup without stealing focus", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const firstTab = activeTabId();
    browserStub.open.mockClear();

    act(() => newTabListener?.({ tabId: "some-background-tab", url: "https://ads.example.com" }));

    expect(activeTabId()).toBe(firstTab);
    expect(browserStub.open).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("recreates a restored neighbor's webview when closing the active tab", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const firstTab = activeTabId();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));

    // Simulate the first tab having been restored from a previous run:
    // its native webview does not exist in this app run.
    unmarkBrowserTabMaterialized(firstTab);
    browserStub.open.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Close tab.*google/i }));
    expect(activeTabId()).toBe(firstTab);
    expect(browserStub.open).toHaveBeenCalledWith(expect.objectContaining({ tabId: firstTab }));
  });

  it("reopens the last closed tab on ⌘⇧T", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const secondTab = activeTabId();
    fireEvent.click(screen.getByRole("button", { name: /Close tab.*google/i }));
    expect(activeTabId()).not.toBe(secondTab);

    fireEvent.keyDown(document.body, { key: "T", metaKey: true, shiftKey: true });
    expect(browserStub.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.google.com", tabId: activeTabId() })
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("retries webview creation after a failed open instead of leaving a zombie tab", async () => {
    browserStub.open.mockRejectedValueOnce({ message: "boom" });
    const { rerender } = render(
      <BrowserPanel url="https://github.com" requestSeq={1} onClose={() => undefined} />
    );
    expect(await screen.findByRole("status")).toHaveTextContent("boom");

    // The failed tab was un-marked, so the next open request recreates the
    // webview instead of navigating a label that never existed.
    rerender(<BrowserPanel url="https://github.com" requestSeq={2} onClose={() => undefined} />);
    expect(browserStub.open).toHaveBeenCalledTimes(2);
    expect(browserStub.navigate).not.toHaveBeenCalled();
  });

  it("opens a new tab on ⌘T regardless of focus", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const firstTab = activeTabId();
    // macOS WebKit leaves focus on <body> after clicks — ⌘T must still work.
    fireEvent.keyDown(document.body, { key: "t", metaKey: true });
    expect(activeTabId()).not.toBe(firstTab);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("closes the active tab on the menu's close request", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://github.com" onClose={onClose} />);
    const firstTab = activeTabId();
    act(() => {
      requestCloseActiveBrowserTab();
    });
    expect(browserStub.close).toHaveBeenCalledWith(firstTab);
    expect(onClose).toHaveBeenCalled();
  });

  it("routes shortcuts pressed inside the page to tab actions", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://github.com" onClose={onClose} />);
    const firstTab = activeTabId();

    act(() => pageCommandListener?.({ tabId: firstTab, command: "new-tab" }));
    const secondTab = activeTabId();
    expect(secondTab).not.toBe(firstTab);
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    act(() => pageCommandListener?.({ tabId: secondTab, command: "close-tab" }));
    expect(browserStub.close).toHaveBeenCalledWith(secondTab);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => pageCommandListener?.({ tabId: firstTab, command: "focus-address" }));
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveFocus();
  });

  it("navigates history from the page's mouse thumb buttons", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const firstTab = activeTabId();

    act(() => pageCommandListener?.({ tabId: firstTab, command: "back" }));
    expect(browserStub.back).toHaveBeenCalledWith(firstTab);

    act(() => pageCommandListener?.({ tabId: firstTab, command: "forward" }));
    expect(browserStub.forward).toHaveBeenCalledWith(firstTab);
  });

  it("navigates history from thumb buttons clicked on the pane chrome", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const tabId = activeTabId();
    const toolbarTarget = screen.getByRole("textbox", { name: "Address" });

    fireEvent.mouseUp(toolbarTarget, { button: 3 });
    expect(browserStub.back).toHaveBeenCalledWith(tabId);

    fireEvent.mouseUp(toolbarTarget, { button: 4 });
    expect(browserStub.forward).toHaveBeenCalledWith(tabId);
  });

  it("surfaces the 1Password fill result", async () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Fill login from 1Password" }));
    expect(browserStub.fillCredentials).toHaveBeenCalledWith(activeTabId());
    expect(await screen.findByText("Filled from 1Password: GitHub")).toBeInTheDocument();
  });
});
