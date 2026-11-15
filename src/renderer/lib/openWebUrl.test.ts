// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserRequest,
  resetBrowserSurfaceForTests,
  subscribeBrowserRequest,
} from "./browserPanel.js";
import { LINK_TARGET_KEY } from "./linkTarget.js";
import { openWebUrl } from "./openWebUrl.js";

afterEach(() => {
  window.localStorage.removeItem(LINK_TARGET_KEY);
  resetBrowserSurfaceForTests();
  delete (window as { argmax?: unknown }).argmax;
  vi.unstubAllGlobals();
});

describe("openWebUrl", () => {
  it("opens in the system browser by default", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = { system: { openPath } };
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    openWebUrl("https://github.com/o/r/pull/1");

    expect(openPath).toHaveBeenCalledWith({ path: "https://github.com/o/r/pull/1" });
    expect(opened).toHaveLength(0);
    unsubscribe();
  });

  it("opens in the in-app browser when the link target is argmax", () => {
    window.localStorage.setItem(LINK_TARGET_KEY, "argmax");
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    openWebUrl("https://github.com/o/r/pull/1");

    expect(opened).toEqual(["https://github.com/o/r/pull/1"]);
    unsubscribe();
  });

  it("flips to the other target on ⌘/Ctrl", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = { system: { openPath } };
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) opened.push(request.url);
    });

    openWebUrl("https://github.com/o/r/pull/1", { flip: true });

    expect(opened).toEqual(["https://github.com/o/r/pull/1"]);
    expect(openPath).not.toHaveBeenCalled();
    unsubscribe();
  });
});
