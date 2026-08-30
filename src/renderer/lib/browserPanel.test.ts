// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  normalizeBrowserUrl,
  onBrowserPanelRequest,
  openInBrowserPanel,
  resolveBrowserInput
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

describe("browser panel request bus", () => {
  it("delivers open requests to the subscriber and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onBrowserPanelRequest(listener);
    openInBrowserPanel("https://github.com");
    expect(listener).toHaveBeenCalledWith("https://github.com");
    unsubscribe();
    openInBrowserPanel("https://example.com");
    expect(listener).toHaveBeenCalledTimes(1);
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
