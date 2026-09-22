import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { setupAppTestMocks, mockDashboardSnapshot, snapshot } from "../test/appTestHarness.js";

describe("App unified search palette", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("⌘K opens the palette on the All filter", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("All");
    expect(dialog).toBeInTheDocument();
  });

  it("searches chats and projects beyond the first forty catalog entries", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: Array.from({ length: 51 }, (_, index) => ({
        ...snapshot.workspaces[0], id: `workspace-${index}`, taskLabel: index === 50 ? "Zircon chat" : `Task ${index}`
      })),
      sessions: Array.from({ length: 51 }, (_, index) => ({
        ...snapshot.sessions[0], id: `session-${index}`, workspaceId: `workspace-${index}`
      })),
      projects: [...snapshot.projects, ...Array.from({ length: 41 }, (_, index) => ({
        ...snapshot.projects[0], id: `project-extra-${index}`, name: index === 40 ? "Zircon project" : `Project ${index}`
      }))]
    });
    render(<App />);
    await screen.findByRole("button", { name: "Task 0" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Command palette query" }), {
      target: { value: "Zircon" }
    });
    expect(screen.getByRole("option", { name: /Zircon chat/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Zircon project/ })).toBeInTheDocument();
  });

  it("⌘P opens the same palette with the Files filter selected", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.keyDown(document, { key: "p", metaKey: true });

    await screen.findByRole("dialog", { name: "Command palette" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Files");
    expect(screen.getByRole("searchbox", { name: "Command palette query" })).toHaveAttribute(
      "placeholder",
      "Search files…"
    );
  });

  it("re-selects the All filter when ⌘K follows ⌘P", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.keyDown(document, { key: "p", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Files");

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("All");
  });

  it("opens a settings page from the Settings filter", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    // Palette rows commit on mousedown so the input never loses focus first.
    fireEvent.mouseDown(screen.getByText("Theme"));

    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});
