import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PAGE_OWNER_ID,
  getBrowserOwnerId,
  getActiveBrowserTabId,
  getBrowserTabs,
  openInBrowserPanel,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests
} from "../lib/browserPanel.js";
import { BrowserPage } from "./BrowserPage.js";

describe("BrowserPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserSurfaceForTests();
    resetBrowserTabsForTests();
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        browser: {
          open: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
          back: vi.fn().mockResolvedValue({ ok: true }),
          forward: vi.fn().mockResolvedValue({ ok: true }),
          reload: vi.fn().mockResolvedValue({ ok: true }),
          setBounds: vi.fn().mockResolvedValue({ ok: true }),
          focus: vi.fn().mockResolvedValue({ ok: true }),
          close: vi.fn().mockResolvedValue({ ok: true }),
          stop: vi.fn().mockResolvedValue({ ok: true }),
          fillCredentials: vi.fn().mockResolvedValue({ ok: true, itemTitle: "Test" }),
          onState: () => () => undefined,
          onNewTab: () => () => undefined,
          onPageCommand: () => () => undefined,
          onTabs: () => () => undefined,
          onAgentOpen: () => () => undefined,
          listTabs: vi.fn().mockResolvedValue({ tabs: [] })
        }
      }
    });
  });

  afterEach(() => {
    cleanup();
    resetBrowserSurfaceForTests();
    resetBrowserTabsForTests();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("claims the native browser surface and fills the workspace", () => {
    render(<BrowserPage onClose={() => undefined} />);

    expect(screen.getByRole("region", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Browser" })).toBeInTheDocument();
    expect(getBrowserOwnerId()).toBe(BROWSER_PAGE_OWNER_ID);
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
  });

  it("restores the selected tab without replaying the link that opened the page", () => {
    openInBrowserPanel("https://first.example", { newTab: true });
    const first = render(<BrowserPage onClose={() => undefined} />);
    const selected = getActiveBrowserTabId(BROWSER_PAGE_OWNER_ID);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(screen.getByRole("button", { name: "first.example" }));
    const count = getBrowserTabs(BROWSER_PAGE_OWNER_ID).length;
    first.unmount();

    render(<BrowserPage onClose={() => undefined} />);

    expect(getActiveBrowserTabId(BROWSER_PAGE_OWNER_ID)).toBe(selected);
    expect(getBrowserTabs(BROWSER_PAGE_OWNER_ID)).toHaveLength(count);
    expect(screen.getByRole("tab", { name: /first.example/ })).toHaveAttribute("aria-selected", "true");
  });

  it("Esc closes the page when no overlay is open", () => {
    const onClose = vi.fn();
    render(<BrowserPage onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("releases the surface on unmount", () => {
    const { unmount } = render(<BrowserPage onClose={() => undefined} />);
    expect(getBrowserOwnerId()).toBe(BROWSER_PAGE_OWNER_ID);

    unmount();

    expect(getBrowserOwnerId()).toBeNull();
  });
});
