import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { BROWSER_PAGE_OPEN_KEY } from "./lib/uiPreferences.js";
import { setupAppTestMocks } from "../test/appTestHarness.js";

async function renderApp(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });
}

describe("App browser page", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
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
    fireEvent.mouseDown(within(palette).getByText("Open Browser"));

    expect(await screen.findByRole("region", { name: "Browser" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("returns to a chat when that session is clicked", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await screen.findByRole("region", { name: "Browser" });

    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "b", metaKey: true });
    const review = await screen.findByRole("complementary", { name: "Review panel" });
    fireEvent.click(within(review).getByRole("tab", { name: "Browser" }));

    expect(within(review).getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(within(review).getByRole("group", { name: "Browser" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
  });
});
