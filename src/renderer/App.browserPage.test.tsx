import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { BROWSER_PAGE_OPEN_KEY } from "./lib/uiPreferences.js";
import { setupAppTestMocks, snapshot } from "../test/appTestHarness.js";
import type { BrowserAgentOpenEvent } from "../shared/types.js";
import { resetBrowserTabsForTests } from "./lib/browserPanel.js";

async function renderApp(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });
}

describe("App browser page", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    resetBrowserTabsForTests();
    setupAppTestMocks();
  });

  it("opens from the rail and keeps the session sidebar", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Browser" }));

    const page = await screen.findByRole("region", { name: "Browser" });
    expect(page).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Usage" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(BROWSER_PAGE_OPEN_KEY)).toBe("true");
  });

  it("opens from the command palette", async () => {
    await renderApp();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.mouseDown(within(palette).getByText("Open browser"));

    expect(await screen.findByRole("region", { name: "Browser" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("returns to a chat from the palette while Browser is open", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await screen.findByRole("region", { name: "Browser" });

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.mouseDown(within(palette).getByRole("option", { name: /Build dashboard/ }));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(BROWSER_PAGE_OPEN_KEY)).toBe("false");
  });

  it("opens a project from the palette while Browser is open", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await screen.findByRole("region", { name: "Browser" });

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.mouseDown(within(palette).getByRole("option", { name: /\/tmp\/argmax/ }));

    expect(screen.queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(BROWSER_PAGE_OPEN_KEY)).toBe("false");
  });

  it("returns to a chat when that session is clicked", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await screen.findByRole("region", { name: "Browser" });

    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser" })).not.toHaveAttribute("aria-current");
    expect(window.localStorage.getItem(BROWSER_PAGE_OPEN_KEY)).toBe("false");
  });

  it("restores the page on launch when it was showing", async () => {
    window.localStorage.setItem(BROWSER_PAGE_OPEN_KEY, "true");

    await renderApp();

    expect(await screen.findByRole("region", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("still opens Browser in a chat's review panel", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "b", metaKey: true });
    const review = await screen.findByRole("complementary", { name: "Review panel" });
    fireEvent.click(within(review).getByRole("tab", { name: "Browser" }));

    expect(within(review).getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(within(review).getByRole("group", { name: "Browser" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
  });

  it("reveals a closed sidebar on the first agent browser event and then leaves Files selected", async () => {
    let emitAgentOpen: ((event: BrowserAgentOpenEvent) => void) | undefined;
    window.argmax!.browser.onAgentOpen = (listener) => {
      emitAgentOpen = listener;
      return () => undefined;
    };
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("region", { name: "Conversation" });
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();
    expect(emitAgentOpen).toBeDefined();

    act(() => emitAgentOpen!({ sessionId: snapshot.sessions[0].id, tabId: "agent-1", url: "https://example.com" }));
    const review = await screen.findByRole("complementary", { name: "Review panel" });
    expect(within(review).getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(within(review).getByRole("group", { name: "Browser" })).toBeInTheDocument();

    fireEvent.click(within(review).getByRole("tab", { name: "Files" }));
    act(() => emitAgentOpen!({ sessionId: snapshot.sessions[0].id, tabId: "agent-2", url: "https://example.com/next" }));
    expect(within(review).getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "b", metaKey: true });
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();
    act(() => emitAgentOpen!({ sessionId: snapshot.sessions[0].id, tabId: "agent-3", url: "https://example.com/last" }));
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();
  });
});
