// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTab, getActiveBrowserTabId, getBrowserRequest, getBrowserTabs, openInBrowserPanel, resetBrowserSurfaceForTests, resetBrowserTabsForTests } from "../lib/browserPanel.js";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import { useStandaloneBrowserLinks } from "./useStandaloneBrowserLinks.js";

afterEach(() => {
  window.localStorage.removeItem(LINK_TARGET_KEY);
  resetBrowserSurfaceForTests();
  resetBrowserTabsForTests();
  delete (window as { argmax?: unknown }).argmax;
});

describe("useStandaloneBrowserLinks", () => {
  it("activates an explicitly requested new tab even when the default target is system", () => {
    const existingTab = createBrowserTab("https://example.com/existing");
    const onOpenInAppBrowser = vi.fn();
    renderHook(() => useStandaloneBrowserLinks({ active: true, onOpenInAppBrowser }));

    act(() => openInBrowserPanel("https://example.com/new", { newTab: true }));

    expect(onOpenInAppBrowser).toHaveBeenCalledWith("https://example.com/new");
    expect(getActiveBrowserTabId()).toBe(getBrowserRequest()?.tabId);
    expect(getActiveBrowserTabId()).not.toBe(existingTab.id);
    expect(getBrowserTabs()).toHaveLength(2);
    expect(getBrowserTabs()[0]).toEqual(existingTab);
  });

  it("opens the in-app browser page when a standalone page is active", () => {
    const onOpenInAppBrowser = vi.fn();
    window.localStorage.setItem(LINK_TARGET_KEY, "argmax");
    renderHook(() =>
      useStandaloneBrowserLinks({
        active: true,
        onOpenInAppBrowser
      })
    );

    act(() => openInBrowserPanel("https://cursor.com/dashboard/spending"));

    expect(onOpenInAppBrowser).toHaveBeenCalledWith("https://cursor.com/dashboard/spending");
  });

  it("ignores requests while no standalone page is active", () => {
    const onOpenInAppBrowser = vi.fn();
    window.localStorage.setItem(LINK_TARGET_KEY, "argmax");
    renderHook(() =>
      useStandaloneBrowserLinks({
        active: false,
        onOpenInAppBrowser
      })
    );

    act(() => openInBrowserPanel("https://cursor.com/dashboard/spending"));

    expect(onOpenInAppBrowser).not.toHaveBeenCalled();
  });

  it("does not replay a request raised before the standalone page opened", () => {
    const onOpenInAppBrowser = vi.fn();
    window.localStorage.setItem(LINK_TARGET_KEY, "argmax");
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useStandaloneBrowserLinks({ active, onOpenInAppBrowser }),
      { initialProps: { active: false } }
    );

    act(() => openInBrowserPanel("https://cursor.com/dashboard/spending"));
    rerender({ active: true });

    expect(onOpenInAppBrowser).not.toHaveBeenCalled();
  });

  it("falls back to system open-path when the link target is the system browser", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = { system: { openPath } };
    const onOpenInAppBrowser = vi.fn();
    renderHook(() =>
      useStandaloneBrowserLinks({
        active: true,
        onOpenInAppBrowser
      })
    );

    act(() => openInBrowserPanel("https://cursor.com/dashboard/spending"));

    expect(openPath).toHaveBeenCalledWith({ path: "https://cursor.com/dashboard/spending" });
    expect(onOpenInAppBrowser).not.toHaveBeenCalled();
    expect(getBrowserRequest()?.url).toBe("https://cursor.com/dashboard/spending");
  });
});
