import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserOwnerId,
  applyBrowserTabs,
  getBrowserTabs,
  createBrowserTab,
  markBrowserTabMaterialized,
  getBrowserTabFocusRequest,
  updateBrowserTabState,
  LAUNCHER_BROWSER_SCOPE_ID,
  openInBrowserPanel,
  rememberBrowserUrl,
  requestAgentBrowserOpen,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests
} from "../lib/browserPanel.js";
import type { BrowserTabInfo } from "../../shared/types.js";
import { useReviewState } from "./useReviewState.js";

/** Enough of the bridge for the hook's mount effect; no source is needed,
 *  because Browser mode has nothing to read from a workspace. */
let nativeNewTabListener: ((event: { tabId: string; url: string }) => void) | null = null;

function stubBridge(): void {
  nativeNewTabListener = null;
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      browser: { onNewTab: (listener: (event: { tabId: string; url: string }) => void) => { nativeNewTabListener = listener; return () => undefined; } },
      review: { listChangedFiles: vi.fn().mockResolvedValue([]), loadDiff: vi.fn().mockResolvedValue(null) },
      workspace: { listFiles: vi.fn().mockResolvedValue([]) }
    }
  });
}

function renderPanel(claimsBrowserRequests: boolean, sessionId?: string) {
  return renderHook(
    ({ claims }: { claims: boolean }) =>
      useReviewState(null, { claimsBrowserRequests: claims, sessionId }),
    { initialProps: { claims: claimsBrowserRequests } }
  );
}

describe("useReviewState — browser mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserSurfaceForTests();
    stubBridge();
  });

  afterEach(() => {
    cleanup();
    resetBrowserSurfaceForTests();
    resetBrowserTabsForTests();
    delete (window as unknown as { argmax?: unknown }).argmax;
    delete window.__TAURI_INTERNALS__;
  });

  it("opens a requested URL in a new tab and reuses a matching tab in this scope", () => {
    const panel = renderPanel(true, "session-1");
    const url = "https://claude.ai/artifacts";
    act(() => panel.result.current.openBrowser(url));
    expect(panel.result.current.browserRequest).toMatchObject({ url, newTab: true });
    const existing = getBrowserTabs("session-1")[0];
    act(() => panel.result.current.openBrowser(url));
    expect(panel.result.current.browserRequest).toMatchObject({ url, tabId: existing.id, newTab: false });
    expect(panel.result.current.mode).toBe("browser");
  });

  it("replaces the new-tab chooser with a browser page", () => {
    const panel = renderPanel(true, "new-browser-tab");
    act(() => panel.result.current.tabs!.openTool("new"));
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/chosen"));
    expect(panel.result.current.mode).toBe("browser");
    expect(panel.result.current.tabs!.items.some((tab) => tab.id === "tool:new")).toBe(false);
    expect(getBrowserTabs("new-browser-tab")[0].url).toBe("https://example.com/chosen");
  });

  it("keeps a browser tab when native close fails and removes it after a successful retry", async () => {
    const panel = renderPanel(true, "close-browser");
    const close = vi.fn().mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    const browserApi = window.argmax?.browser;
    if (!browserApi) throw new Error("Missing browser bridge");
    Object.assign(browserApi, { close });
    act(() => panel.result.current.tabs!.openBrowser("https://example.com"));
    const browser = panel.result.current.tabs!.items.find((tab) => tab.kind === "browser")!;
    if (browser.kind !== "browser") throw new Error("Missing browser tab");
    markBrowserTabMaterialized(browser.browserTabId);
    await act(async () => {
      panel.result.current.tabs!.close(browser.id);
      await Promise.resolve();
    });
    expect(panel.result.current.tabs!.items.some((tab) => tab.id === browser.id)).toBe(true);
    expect(getBrowserTabs("close-browser")).toHaveLength(1);
    expect(panel.result.current.tabs!.canReopen).toBe(false);
    await act(async () => {
      panel.result.current.tabs!.close(browser.id);
      await Promise.resolve();
    });
    await waitFor(() => expect(panel.result.current.tabs!.items.some((tab) => tab.id === browser.id)).toBe(false));
    expect(getBrowserTabs("close-browser")).toHaveLength(0);
    act(() => panel.result.current.tabs!.reopenClosed());
    expect(getBrowserTabs("close-browser")[0].url).toBe("https://example.com");
    expect(panel.result.current.tabs!.items.some((tab) => tab.id === browser.id)).toBe(false);
  });

  it("closes an unmaterialized restored page without calling the native close command", () => {
    const close = vi.fn().mockRejectedValue(new Error("BROWSER_NOT_OPEN"));
    Object.assign(window.argmax?.browser ?? {}, { close });
    const restored = createBrowserTab("unmaterialized", "https://example.com/restored");
    const panel = renderPanel(true, "unmaterialized");
    act(() => panel.result.current.tabs!.close(`browser:${restored.id}`));
    expect(close).not.toHaveBeenCalled();
    expect(getBrowserTabs("unmaterialized")).toHaveLength(0);
    expect(panel.result.current.tabs!.items.some((tab) => tab.id === `browser:${restored.id}`)).toBe(false);
    expect(panel.result.current.tabs!.canReopen).toBe(true);
  });

  it.each([true, false])("focuses a promoted page only when closing the active page (%s)", async (closeActive) => {
    const close = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.argmax?.browser ?? {}, { close });
    const panel = renderPanel(true, "close-page-focus");
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/first"));
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/second"));
    const pages = getBrowserTabs("close-page-focus");
    const closing = pages[closeActive ? 1 : 0];
    const survivor = pages[closeActive ? 0 : 1];
    markBrowserTabMaterialized(closing.id);
    expect(getBrowserTabFocusRequest(survivor.id)).toBeNull();
    await act(async () => {
      panel.result.current.tabs!.close(`browser:${closing.id}`);
      await Promise.resolve();
    });
    expect(panel.result.current.tabs!.paneTabIds).toEqual([`browser:${survivor.id}`]);
    if (closeActive) expect(getBrowserTabFocusRequest(survivor.id)).not.toBeNull();
    else expect(getBrowserTabFocusRequest(survivor.id)).toBeNull();
  });

  it("preserves close focus when the native registry push arrives before the close reply", async () => {
    let resolveClose: () => void = () => undefined;
    const pendingClose = new Promise<void>((resolve) => { resolveClose = resolve; });
    Object.assign(window.argmax?.browser ?? {}, { close: vi.fn().mockReturnValue(pendingClose) });
    const panel = renderPanel(true, "registry-before-close");
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/first"));
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/second"));
    const [survivor, closing] = getBrowserTabs("registry-before-close");
    const registryTabs = [survivor, closing].map((tab) => ({ tabId: tab.id, ownerSessionId: null, url: tab.url, title: null, loading: false, group: null }));
    act(() => applyBrowserTabs(registryTabs));
    act(() => panel.result.current.tabs!.close(`browser:${closing.id}`));
    act(() => applyBrowserTabs([registryTabs[0]]));
    expect(panel.result.current.tabs!.paneTabIds).toEqual([`browser:${closing.id}`]);
    await act(async () => { resolveClose(); await pendingClose; });
    expect(panel.result.current.tabs!.paneTabIds).toEqual([`browser:${survivor.id}`]);
    expect(getBrowserTabFocusRequest(survivor.id)).not.toBeNull();
    expect(panel.result.current.isPanelOpen).toBe(true);
    expect(panel.result.current.tabs!.canReopen).toBe(true);
  });

  it("adds background browser tabs without stealing split focus", () => {
    const panel = renderPanel(true, "background-tabs");
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/first"));
    act(() => panel.result.current.splitMode("changes", "bottom"));
    const before = panel.result.current.tabs!.paneTabIds;
    act(() => { createBrowserTab("background-tabs", "https://example.com/background"); });
    expect(panel.result.current.tabs!.items.filter((tab) => tab.kind === "browser")).toHaveLength(2);
    expect(panel.result.current.tabs!.paneTabIds).toEqual(before);
    expect(panel.result.current.layout.activeIndex).toBe(1);
  });

  it("routes native new tabs once even when their source is hidden or its chat unmounted", () => {
    const panel = renderPanel(true, "native-new-tabs");
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/source"));
    const source = getBrowserTabs("native-new-tabs")[0];
    act(() => panel.result.current.tabs!.openTool("changes"));
    act(() => nativeNewTabListener?.({ tabId: source.id, url: "https://example.com/background" }));
    expect(getBrowserTabs("native-new-tabs")).toHaveLength(2);
    expect(panel.result.current.mode).toBe("changes");
    expect(panel.result.current.tabs!.items.filter((tab) => tab.kind === "browser")).toHaveLength(2);
    panel.unmount();
    act(() => nativeNewTabListener?.({ tabId: source.id, url: "https://example.com/unmounted" }));
    expect(getBrowserTabs("native-new-tabs")).toHaveLength(3);
    expect(getBrowserTabs("native-new-tabs")[2].url).toBe("https://example.com/unmounted");
  });

  it("opens a native link in its source pane without changing focus in the other pane", () => {
    const panel = renderPanel(true, "native-split");
    act(() => panel.result.current.tabs!.openBrowser("https://example.com/source"));
    const source = getBrowserTabs("native-split")[0];
    act(() => panel.result.current.splitMode("changes", "bottom"));
    act(() => nativeNewTabListener?.({ tabId: source.id, url: "https://example.com/next" }));
    expect(panel.result.current.tabs!.paneTabIds[0]).toBe(`browser:${getBrowserTabs("native-split")[1].id}`);
    expect(panel.result.current.mode).toBe("changes");
    expect(panel.result.current.layout.activeIndex).toBe(1);
    expect(panel.result.current.browserRequest?.newTab).toBe(false);
  });

  it("waits for browser registry hydration before pruning unresolved restored tabs", async () => {
    let resolveSnapshot: (value: { tabs: BrowserTabInfo[] }) => void = () => undefined;
    const initialSnapshot = new Promise<{ tabs: BrowserTabInfo[] }>((resolve) => { resolveSnapshot = resolve; });
    Object.assign(window.argmax?.browser ?? {}, {
      onTabs: vi.fn().mockReturnValue(() => undefined),
      onAgentOpen: vi.fn().mockReturnValue(() => undefined),
      listTabs: vi.fn().mockReturnValue(initialSnapshot)
    });
    localStorage.setItem("argmax.reviewPanel.layout.hydrating", JSON.stringify({
      version: 2,
      tabs: [
        { id: "browser:hydrating", kind: "browser", browserTabId: "hydrating" },
        { id: "browser:missing", kind: "browser", browserTabId: "missing" }
      ],
      paneTabIds: ["browser:hydrating", "browser:missing"], activeIndex: 1, ratio: 0.5
    }));
    const panel = renderPanel(true, "hydrating");
    expect(panel.result.current.tabs!.items).toHaveLength(2);
    expect(panel.result.current.tabs!.paneTabIds).toEqual(["browser:hydrating", "browser:missing"]);
    await act(async () => {
      resolveSnapshot({ tabs: [{ tabId: "hydrating", ownerSessionId: "hydrating", url: "https://example.com/restored", title: null, loading: false, group: null }] });
      await initialSnapshot;
    });
    await waitFor(() => expect(panel.result.current.tabs!.items.some((tab) => tab.id === "browser:missing")).toBe(false));
    expect(panel.result.current.tabs!.items.some((tab) => tab.id === "browser:hydrating")).toBe(true);
    expect(panel.result.current.tabs!.paneTabIds).toEqual(["browser:hydrating"]);
  });

  it("offers no Browser mode in a window torn off from the main one", () => {
    // The native tabs are children of the main window; a panel here would
    // drag them to this window's coordinates through browser:set-bounds.
    window.localStorage.setItem(
      "argmax.reviewPanel.layout.session-1",
      JSON.stringify({ modes: ["browser"], activeIndex: 0, ratio: 0.5 })
    );
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "chat-1" } } };

    const { result } = renderPanel(true, "session-1");

    expect(result.current.layout.modes).not.toContain("browser");
    expect(result.current.mode).not.toBe("browser");
  });

  it("does not spend the first reveal in a window that cannot host Browser", () => {
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "chat-1" } } };
    const detached = renderPanel(false, "session-a");
    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));
    expect(detached.result.current.isPanelOpen).toBe(false);
    expect(window.localStorage.getItem("argmax.browser.agentRevealed.session-a")).toBeNull();
    detached.unmount();

    delete window.__TAURI_INTERNALS__;
    const main = renderPanel(false, "session-a");
    act(() => requestAgentBrowserOpen("session-a", "agent-2", "https://example.com/next"));
    expect(main.result.current.isPanelOpen).toBe(true);
    expect(main.result.current.mode).toBe("browser");
  });

  it("restores Browser with the current tab URL instead of the start page", () => {
    const first = renderPanel(true, "session-a");
    act(() => first.result.current.openBrowser());
    act(() => {
      rememberBrowserUrl("https://example.com/current-page", "session-a");
      updateBrowserTabState(getBrowserTabs("session-a")[0].id, "https://example.com/current-page", null);
    });
    first.unmount();

    const restored = renderPanel(true, "session-a");
    expect(restored.result.current.isPanelOpen).toBe(true);
    expect(restored.result.current.mode).toBe("browser");
    expect(restored.result.current.browserOwner).toBe(true);
    expect(restored.result.current.browserRequest?.url).toBe("https://example.com/current-page");
  });

  it("shows a session's agent tab in that session's pane and nowhere else", () => {
    const mine = renderPanel(false, "session-a");
    const other = renderPanel(true, "session-b");
    const launcher = renderPanel(true);

    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));

    expect(mine.result.current.mode).toBe("browser");
    expect(mine.result.current.isPanelOpen).toBe(true);
    expect(mine.result.current.browserOwner).toBe(true);
    expect(mine.result.current.browserRequest).toMatchObject({
      url: "https://example.com",
      tabId: "agent-1"
    });
    // Focus does not enter into it: the pane showing the session does.
    expect(other.result.current.mode).toBe("changes");
    expect(launcher.result.current.mode).toBe("changes");
  });

  it("reveals once per session and preserves later sidebar choices across remounts", () => {
    const panel = renderPanel(false, "session-a");
    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));
    expect(panel.result.current.isPanelOpen).toBe(true);
    expect(panel.result.current.mode).toBe("browser");

    act(() => panel.result.current.setMode("files"));
    act(() => requestAgentBrowserOpen("session-a", "agent-2", "https://example.com/next"));
    expect(panel.result.current.mode).toBe("files");
    expect(panel.result.current.browserRequest?.tabId).toBe("agent-2");

    act(() => panel.result.current.openBrowser());
    expect(panel.result.current.browserRequest?.tabId).toBe("agent-2");
    act(() => panel.result.current.setMode("files"));

    act(() => panel.result.current.closePanel());
    panel.unmount();
    const restored = renderPanel(false, "session-a");
    act(() => requestAgentBrowserOpen("session-a", "agent-3", "https://example.com/last"));
    expect(restored.result.current.isPanelOpen).toBe(false);
    expect(restored.result.current.mode).toBe("files");

    const other = renderPanel(false, "session-b");
    act(() => requestAgentBrowserOpen("session-b", "agent-4", "https://example.com"));
    expect(other.result.current.isPanelOpen).toBe(true);
    expect(other.result.current.mode).toBe("browser");
  });

  it("keeps split focus on Agents while later agent tabs update Browser", () => {
    const panel = renderPanel(false, "session-a");
    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));
    act(() => panel.result.current.splitMode("agents", "bottom"));
    const layout = panel.result.current.layout;

    act(() => requestAgentBrowserOpen("session-a", "agent-2", "https://example.com/next"));
    expect(panel.result.current.layout).toEqual(layout);
    expect(panel.result.current.mode).toBe("agents");
    expect(panel.result.current.browserOwner).toBe(true);
    expect(panel.result.current.browserRequest?.tabId).toBe("agent-2");
  });

  it("does not replay an agent tab opened before the pane mounted", () => {
    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));
    const late = renderPanel(false, "session-a");

    // The tab is in the strip either way; yanking a pane into Browser mode
    // when the reader arrives minutes later is not what they asked for.
    expect(late.result.current.mode).toBe("changes");
  });

  it("routes an open request to the panel taking them and leaves the other alone", () => {
    const claiming = renderPanel(true);
    const idle = renderPanel(false);

    act(() => openInBrowserPanel("https://argmax.dev", { newTab: true }));

    expect(claiming.result.current.mode).toBe("browser");
    expect(claiming.result.current.isPanelOpen).toBe(true);
    expect(claiming.result.current.browserOwner).toBe(true);
    expect(claiming.result.current.browserRequest?.url).toBe("https://argmax.dev");
    expect(claiming.result.current.browserRequest?.newTab).toBe(true);
    expect(claiming.result.current.browserRequest?.tabId).toBe(getBrowserTabs(LAUNCHER_BROWSER_SCOPE_ID)[0]?.id);
    expect(idle.result.current.mode).toBe("changes");
    expect(idle.result.current.browserOwner).toBe(false);
  });

  it("does not replay a request that landed while the panel was not taking them", () => {
    const panel = renderPanel(false);
    act(() => openInBrowserPanel("https://argmax.dev"));
    expect(panel.result.current.mode).toBe("changes");

    // Focus arriving later is not a request: clicking into a pane must not
    // pull up a page the reader asked for somewhere else.
    panel.rerender({ claims: true });
    expect(panel.result.current.mode).toBe("changes");
  });

  it("opens browser on the first render after an open request", () => {
    const snapshots: Array<{ isPanelOpen: boolean; mode: string }> = [];
    renderHook(() => {
      const state = useReviewState(null, { claimsBrowserRequests: true });
      snapshots.push({ isPanelOpen: state.isPanelOpen, mode: state.mode });
      return state;
    });
    snapshots.length = 0;

    act(() => openInBrowserPanel("https://argmax.dev"));

    expect(snapshots[0]).toEqual({ isPanelOpen: true, mode: "browser" });
  });

  it("keeps both session browsers visible when another cell opens and closes its browser", () => {
    const first = renderPanel(true, "session-a");
    const second = renderPanel(false, "session-b");
    act(() => first.result.current.openBrowser());
    const firstRequest = first.result.current.browserRequest;
    act(() => second.result.current.openBrowser());
    expect(first.result.current.browserOwner).toBe(true);
    expect(second.result.current.browserOwner).toBe(true);
    expect(first.result.current.browserRequest).toBe(firstRequest);
    act(() => second.result.current.closePanel());
    expect(first.result.current.browserOwner).toBe(true);
    second.unmount();
    expect(first.result.current.browserOwner).toBe(true);
  });

  it("hands the surface to a second panel showing the same scope", () => {
    const first = renderPanel(true);
    const second = renderPanel(false);

    act(() => first.result.current.openBrowser());
    expect(first.result.current.browserOwner).toBe(true);

    act(() => second.result.current.openBrowser());
    expect(second.result.current.browserOwner).toBe(true);
    expect(first.result.current.browserOwner).toBe(false);
    // The demoted panel stays in Browser mode, showing the placeholder.
    expect(first.result.current.mode).toBe("browser");
  });

  it("lets a demoted panel take the surface back", () => {
    const first = renderPanel(true);
    const second = renderPanel(false);

    act(() => first.result.current.openBrowser());
    act(() => second.result.current.openBrowser());

    // "Show here" on the demoted panel: it is already in Browser mode with
    // the panel open, so nothing about its own state changes — the claim has
    // to happen on the call itself, not on a state transition.
    act(() => first.result.current.openBrowser());
    expect(first.result.current.browserOwner).toBe(true);
    expect(second.result.current.browserOwner).toBe(false);
  });

  it("releases the surface when the owner leaves Browser mode or unmounts", () => {
    const panel = renderPanel(true);

    act(() => panel.result.current.openBrowser());
    expect(getBrowserOwnerId(LAUNCHER_BROWSER_SCOPE_ID)).not.toBeNull();

    act(() => panel.result.current.setMode("changes"));
    expect(getBrowserOwnerId(LAUNCHER_BROWSER_SCOPE_ID)).toBeNull();

    act(() => panel.result.current.openBrowser());
    act(() => panel.result.current.closePanel());
    expect(getBrowserOwnerId(LAUNCHER_BROWSER_SCOPE_ID)).toBeNull();

    act(() => panel.result.current.openBrowser());
    panel.unmount();
    expect(getBrowserOwnerId(LAUNCHER_BROWSER_SCOPE_ID)).toBeNull();
  });

  it("keeps the browser surface while Browser remains visible in an inactive split pane", () => {
    const panel = renderPanel(true);
    act(() => {
      panel.result.current.openBrowser();
      panel.result.current.splitMode("files", "bottom");
    });

    expect(panel.result.current.mode).toBe("files");
    expect(panel.result.current.layout.modes).toEqual(["browser", "files"]);
    expect(panel.result.current.browserOwner).toBe(true);

    act(() => panel.result.current.closePane(0));
    expect(getBrowserOwnerId(LAUNCHER_BROWSER_SCOPE_ID)).toBeNull();
  });

  it("re-navigates when the same URL is requested twice", () => {
    const panel = renderPanel(true);

    act(() => openInBrowserPanel("https://argmax.dev"));
    const first = panel.result.current.browserRequest;
    act(() => openInBrowserPanel("https://argmax.dev"));
    const second = panel.result.current.browserRequest;

    expect(second?.url).toBe(first?.url);
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0);
  });
});
