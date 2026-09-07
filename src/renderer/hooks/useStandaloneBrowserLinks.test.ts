// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrowserRequest, openInBrowserPanel, resetBrowserSurfaceForTests } from "../lib/browserPanel.js";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import { useStandaloneBrowserLinks } from "./useStandaloneBrowserLinks.js";

afterEach(() => {
  window.localStorage.removeItem(LINK_TARGET_KEY);
  resetBrowserSurfaceForTests();
  delete (window as { argmax?: unknown }).argmax;
});

describe("useStandaloneBrowserLinks", () => {
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
