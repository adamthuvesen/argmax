import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewTabsBar, type ReviewTabsBarProps } from "./ReviewTabsBar.js";

function props(overrides: Partial<ReviewTabsBarProps> = {}): ReviewTabsBarProps {
  return {
    items: [
      { id: "changes", kind: "changes", label: "Changes" },
      { id: "browser-1", kind: "browser", label: "App preview", title: "http://localhost:3000" },
      { id: "file-1", kind: "file", label: "index.ts", title: "src/index.ts", dirty: true }
    ],
    activeId: "changes",
    visibleIds: ["changes"],
    onSelect: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), onSplit: vi.fn(),
    onOpen: vi.fn(), onReopen: vi.fn(), canReopen: false,
    hasAgents: true, hasBrowser: true, hasTerminal: true, artifactsEnabled: false,
    ...overrides
  };
}

afterEach(cleanup);

describe("ReviewTabsBar", () => {
  it("preserves manual tab scrolling across unrelated parent renders", () => {
    const callbacks = props();
    const { rerender } = render(<ReviewTabsBar {...callbacks} />);
    const active = screen.getByRole("tab", { name: "Changes" }).parentElement!;
    const scrollIntoView = vi.fn();
    active.scrollIntoView = scrollIntoView;
    rerender(<ReviewTabsBar {...callbacks} items={callbacks.items.map((item) => ({ ...item }))} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps overflowing tabs reachable in both directions", () => {
    render(<ReviewTabsBar {...props()} />);
    const strip = screen.getByRole("tablist", { name: "Workspace tabs" });
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 700 },
      scrollLeft: { configurable: true, writable: true, value: 0 }
    });
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy;
    fireEvent.scroll(strip);
    expect(screen.getByRole("button", { name: "Scroll tabs left" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 298, behavior: "auto" });
    strip.scrollLeft = 400;
    fireEvent.scroll(strip);
    expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs left" }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -298, behavior: "auto" });
  });

  it("navigates resource tabs with arrows, Home, and End, and closes the focused resource with Delete", () => {
    const callbacks = props();
    render(<ReviewTabsBar {...callbacks} />);
    const changes = screen.getByRole("tab", { name: "Changes" });
    expect(changes).toHaveAttribute("tabindex", "0");
    const browser = screen.getByRole("tab", { name: "http://localhost:3000" });
    const file = screen.getByRole("tab", { name: "src/index.ts" });
    expect(browser).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(changes, { key: "ArrowRight" });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("browser-1");
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "End" });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("file-1");
    expect(file).toHaveFocus();
    fireEvent.keyDown(file, { key: "Home" });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("changes");
    fireEvent.keyDown(changes, { key: "ArrowLeft" });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("file-1");
    fireEvent.keyDown(file, { key: "Delete" });
    expect(callbacks.onClose).toHaveBeenCalledWith("file-1");
    expect(browser).toHaveFocus();
  });

  it("opens only available tools and the optional artifacts shortcut", () => {
    const callbacks = props({ hasAgents: false, hasTerminal: false, artifactsEnabled: true, canReopen: true });
    render(<ReviewTabsBar {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "New workspace tab" }));
    const menu = screen.getByRole("menu", { name: "Open workspace tab" });
    expect(menu).toHaveAttribute("data-browser-overlay", "true");
    expect(within(menu).queryByRole("menuitem", { name: "Agents" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Terminal" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Claude artifacts" }));
    expect(callbacks.onOpen).toHaveBeenCalledWith("artifacts");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("splits the right-clicked tab and exposes bounded reorder actions", () => {
    const callbacks = props();
    render(<ReviewTabsBar {...callbacks} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "http://localhost:3000" }), { clientX: 80, clientY: 60 });
    const menu = screen.getByRole("menu", { name: "App preview tab actions" });
    expect(within(menu).getByRole("menuitem", { name: "Move left" })).toBeEnabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Show below" }));
    expect(callbacks.onSplit).toHaveBeenCalledWith("browser-1", "bottom");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByRole("menuitem", { name: "Move left" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Reopen closed tab" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move right" }));
    expect(callbacks.onMove).toHaveBeenCalledWith("changes", 1);
  });

  it("supports keyboard tab menus and returns focus on Escape", () => {
    const callbacks = props({ canReopen: true });
    render(<ReviewTabsBar {...callbacks} />);
    const browser = screen.getByRole("tab", { name: "http://localhost:3000" });
    browser.focus();
    fireEvent.keyDown(browser, { key: "F10", shiftKey: true });
    const first = screen.getByRole("menuitem", { name: "Show above" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Reopen closed tab" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? first, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(browser).toHaveFocus();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("closes the exact file resource without selecting it and keeps its unsaved indicator accessible", () => {
    const callbacks = props();
    render(<ReviewTabsBar {...callbacks} />);
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close src/index.ts" }));
    expect(callbacks.onClose).toHaveBeenCalledWith("file-1");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("reorders dragged resources without propagating a drag to the split panel", () => {
    const callbacks = props();
    const onPanelDrag = vi.fn();
    render(<div onDragStart={onPanelDrag}><ReviewTabsBar {...callbacks} /></div>);
    const changes = screen.getByRole("tab", { name: "Changes" });
    const browser = screen.getByRole("tab", { name: "http://localhost:3000" });
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
    fireEvent.dragStart(changes, { dataTransfer });
    expect(onPanelDrag).not.toHaveBeenCalled();
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-argmax-review-tab", "changes");
    fireEvent.dragOver(browser, { dataTransfer });
    fireEvent.drop(browser, { dataTransfer });
    expect(callbacks.onMove).toHaveBeenCalledWith("changes", 1);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
