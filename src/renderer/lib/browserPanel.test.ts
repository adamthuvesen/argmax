// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo } from "../../shared/types.js";
import {
  activateBrowserTab,
  applyBrowserTabs,
  claimBrowserSurface,
  createBrowserTab,
  getActiveBrowserTabId,
  getAgentBrowserOpen,
  getBrowserTabs,
  getBrowserOwnerId,
  getBrowserRequest,
  lastBrowsedUrl,
  normalizeBrowserUrl,
  onBrowserCloseActiveTabRequest,
  openBrowserPanel,
  openInBrowserPanel,
  isBrowserTabMaterialized,
  releaseBrowserSurface,
  requestAgentBrowserOpen,
  requestCloseActiveBrowserTab,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests,
  resolveBrowserInput,
  subscribeAgentBrowserOpen,
  subscribeBrowserOwner,
  subscribeBrowserRequest,
  subscribeBrowserTabs
} from "./browserPanel.js";

describe("resolveBrowserInput", () => {
  it("keeps URL-shaped input as a URL", () => {
    expect(resolveBrowserInput("github.com")).toBe("https://github.com");
  });

  it("falls back to a Google search for everything else", () => {
    expect(resolveBrowserInput("tauri multiwebview docs")).toBe(
      "https://www.google.com/search?q=tauri%20multiwebview%20docs"
    );
    expect(resolveBrowserInput("file:///etc/passwd")).toBe(
      "https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd"
    );
  });

  it("returns null for blank input", () => {
    expect(resolveBrowserInput("   ")).toBeNull();
  });
});

describe("normalizeBrowserUrl", () => {
  it("passes http(s) URLs through unchanged", () => {
    expect(normalizeBrowserUrl("https://github.com/login")).toBe("https://github.com/login");
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("upgrades bare hosts to https", () => {
    expect(normalizeBrowserUrl("github.com")).toBe("https://github.com");
    expect(normalizeBrowserUrl("github.com/argmax?tab=repos")).toBe(
      "https://github.com/argmax?tab=repos"
    );
    expect(normalizeBrowserUrl("localhost:5173")).toBe("https://localhost:5173");
  });

  it("rejects other schemes, spaces, and non-hosts", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("what is tauri")).toBeNull();
    expect(normalizeBrowserUrl("notaurl")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });
});

describe("browser open requests", () => {
  afterEach(() => resetBrowserSurfaceForTests());

  it("notifies every subscriber and bumps the sequence per request", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeBrowserRequest(first);
    const stopSecond = subscribeBrowserRequest(second);

    openInBrowserPanel("https://github.com");
    expect(getBrowserRequest()).toEqual({ url: "https://github.com", seq: 1 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The same URL again is still a new request: the reader asked to see it.
    openInBrowserPanel("https://github.com");
    expect(getBrowserRequest()).toEqual({ url: "https://github.com", seq: 2 });

    stopFirst();
    openInBrowserPanel("https://example.com");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
    stopSecond();
  });

  it("reopens where the browser last was", () => {
    expect(lastBrowsedUrl()).toBe("https://www.google.com");
    openInBrowserPanel("https://argmax.dev");
    openBrowserPanel();
    expect(getBrowserRequest()).toEqual({ url: "https://argmax.dev", seq: 2 });
  });
});

describe("browser surface ownership", () => {
  afterEach(() => resetBrowserSurfaceForTests());

  it("hands the surface to the newest claimant and ignores a stale release", () => {
    const listener = vi.fn();
    const stop = subscribeBrowserOwner(listener);

    claimBrowserSurface("panel-a");
    expect(getBrowserOwnerId()).toBe("panel-a");

    // A second panel switching to Browser mode demotes the first.
    claimBrowserSurface("panel-b");
    expect(getBrowserOwnerId()).toBe("panel-b");

    // The demoted panel leaving Browser mode must not release panel-b's claim.
    releaseBrowserSurface("panel-a");
    expect(getBrowserOwnerId()).toBe("panel-b");
    expect(listener).toHaveBeenCalledTimes(2);

    releaseBrowserSurface("panel-b");
    expect(getBrowserOwnerId()).toBeNull();
    stop();
  });

  it("does not notify when the owner re-claims a surface it already holds", () => {
    const listener = vi.fn();
    const stop = subscribeBrowserOwner(listener);
    claimBrowserSurface("panel-a");
    claimBrowserSurface("panel-a");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("close active tab requests", () => {
  it("reports whether a mounted browser consumed the request", () => {
    expect(requestCloseActiveBrowserTab()).toBe(false);
    const listener = vi.fn();
    const stop = onBrowserCloseActiveTabRequest(listener);
    expect(requestCloseActiveBrowserTab()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    expect(requestCloseActiveBrowserTab()).toBe(false);
  });
});

describe("tab persistence", () => {
  it("restores persisted tabs on module load, unmaterialized", async () => {
    window.localStorage.setItem(
      "argmax.browser.tabs",
      JSON.stringify({
        activeTabId: "tab-2",
        nextTabSeq: 3,
        tabs: [
          { id: "tab-1", url: "https://github.com", title: "GitHub" },
          { id: "tab-2", url: "https://example.com", title: null }
        ]
      })
    );
    vi.resetModules();
    const fresh = await import("./browserPanel.js");

    expect(fresh.getBrowserTabs().map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    expect(fresh.getActiveBrowserTabId()).toBe("tab-2");
    // Restored tabs have no native webview until this run recreates one.
    expect(fresh.isBrowserTabMaterialized("tab-1")).toBe(false);
    // The id counter continues past restored ids, so labels never collide.
    expect(fresh.createBrowserTab("https://argmax.dev").id).toBe("tab-3");

    fresh.resetBrowserTabsForTests();
    window.localStorage.removeItem("argmax.browser.tabs");
  });
});

describe("mirroring the app's tab registry", () => {
  afterEach(() => resetBrowserTabsForTests());

  const registryTab = (
    tabId: string,
    overrides: Partial<BrowserTabInfo> = {}
  ): BrowserTabInfo => ({
    tabId,
    ownerSessionId: null,
    group: null,
    url: `https://${tabId}.example`,
    title: null,
    loading: false,
    ...overrides
  });

  it("adds tabs the app opened, marking them live in this run", () => {
    applyBrowserTabs([registryTab("agent-1", { ownerSessionId: "s1", title: "Example" })]);

    const [tab] = getBrowserTabs();
    expect(tab?.id).toBe("agent-1");
    expect(tab?.ownerSessionId).toBe("s1");
    expect(tab?.title).toBe("Example");
    // The app created the webview, so no lazy re-open is needed.
    expect(isBrowserTabMaterialized("agent-1")).toBe(true);
  });

  it("drops a tab that the registry has stopped reporting", () => {
    applyBrowserTabs([registryTab("agent-1"), registryTab("agent-2")]);
    applyBrowserTabs([registryTab("agent-2")]);

    expect(getBrowserTabs().map((tab) => tab.id)).toEqual(["agent-2"]);
  });

  it("leaves a local tab alone until the registry has seen it once", () => {
    // A tab whose browser:open is still in flight, or one restored from a
    // previous run: absent from the push, but not closed.
    const local = createBrowserTab("https://argmax.dev");
    applyBrowserTabs([registryTab("agent-1")]);
    expect(getBrowserTabs().map((tab) => tab.id)).toEqual([local.id, "agent-1"]);

    applyBrowserTabs([registryTab("agent-1"), registryTab(local.id)]);
    applyBrowserTabs([registryTab("agent-1")]);
    expect(getBrowserTabs().map((tab) => tab.id)).toEqual(["agent-1"]);
  });

  it("keeps a title the strip already showed when the push carries none", () => {
    applyBrowserTabs([registryTab("agent-1", { title: "Example Domain" })]);
    applyBrowserTabs([registryTab("agent-1", { title: null, loading: true })]);

    const [tab] = getBrowserTabs();
    expect(tab?.title).toBe("Example Domain");
    expect(tab?.loading).toBe(true);
  });

  it("re-points the active tab when the registry closes the one showing", () => {
    applyBrowserTabs([registryTab("agent-1"), registryTab("agent-2")]);
    activateBrowserTab("agent-2");
    applyBrowserTabs([registryTab("agent-1")]);

    expect(getActiveBrowserTabId()).toBe("agent-1");
  });

  it("does not notify subscribers when nothing changed", () => {
    applyBrowserTabs([registryTab("agent-1")]);
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserTabs(listener);
    applyBrowserTabs([registryTab("agent-1")]);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("agent-opened tabs", () => {
  afterEach(() => resetBrowserTabsForTests());

  it("publishes an addressed request every time, so a repeat still lands", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentBrowserOpen(listener);

    requestAgentBrowserOpen("s1", "agent-1", "https://example.com");
    const first = getAgentBrowserOpen();
    expect(first).toMatchObject({ sessionId: "s1", tabId: "agent-1", url: "https://example.com" });

    requestAgentBrowserOpen("s1", "agent-1", "https://example.com");
    expect(getAgentBrowserOpen()?.seq).toBeGreaterThan(first?.seq ?? 0);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
