import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { MIN_RESIZABLE_CELL_WIDTH_PX } from "./components/SessionMultiGrid.js";
import type { DashboardSnapshot } from "../shared/types.js";
import {
  mockDashboardSnapshot,
  openSettings,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

vi.mock("./components/TerminalTabsPanel.js", () => ({
  TerminalTabsPanel: ({ visible }: { visible: boolean }) => (
    <div data-testid="terminal-tabs-panel" data-visible={String(visible)} />
  )
}));

describe("App grid", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("⌘-click on a sidebar session splits the focused pane to the right", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Split target",
      branch: "argmax/split-target",
      baseRef: "main",
      path: "/tmp/worktrees/split-target",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Split target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    // Open the first session by clicking its sidebar row.
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    // ⌘-click the second session to split the grid to the right.
    fireEvent.click(screen.getByRole("button", { name: "Split target" }), { metaKey: true });

    // Both panes are now mounted simultaneously — heading appears twice.
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(2);
    });

    expect(screen.getByTitle("Build dashboard — running — in view")).toBeInTheDocument();
    expect(screen.getByTitle("Split target — complete — in view")).toBeInTheDocument();

    // Each pane has a close (×) button.
    expect(screen.getAllByRole("button", { name: "Close pane" })).toHaveLength(2);

    // Closing one via the × leaves a single pane.
    fireEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(1);
    });
  });

  it("⌥-click on a sidebar session splits below into a new row", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Below target",
      branch: "argmax/below-target",
      baseRef: "main",
      path: "/tmp/worktrees/below-target",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Below target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    fireEvent.click(screen.getByRole("button", { name: "Below target" }), { altKey: true });

    await waitFor(() => {
      // Two .session-multigrid-row elements (one per row).
      const rows = document.querySelectorAll(".session-multigrid-row");
      expect(rows).toHaveLength(2);
    });
  });

  it("previews and opens the first grid pane when a sidebar session is dropped onto the launcher", async () => {
    render(<App />);

    const row = await screen.findByRole("button", { name: "Build dashboard" });
    expect(row).toHaveAttribute("draggable", "true");

    const setData = vi.fn();
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData,
        setDragImage: vi.fn(),
        effectAllowed: "move"
      }
    });

    expect(setData).toHaveBeenCalled();
    const dropOverlay = await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".workspace-drop-overlay");
      if (!overlay) throw new Error("Expected workspace drop overlay to render");
      return overlay;
    });

    fireEvent.dragOver(dropOverlay, {
      dataTransfer: {
        dropEffect: "move"
      }
    });
    await waitFor(() => {
      expect(document.querySelector('.workspace-drop-zone[data-hovered="true"]')).toBeInTheDocument();
    });

    fireEvent.drop(dropOverlay, {
      dataTransfer: {
        dropEffect: "move"
      }
    });

    expect(await screen.findByRole("group", { name: "Session panes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("keeps the current session and opens a launcher pane to the right from New session", async () => {
    window.localStorage.setItem("argmax.newSessionMode", "embedded");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(await screen.findByRole("region", { name: "New session for Argmax" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Build dashboard" })).toBeInTheDocument();
    const rows = document.querySelectorAll(".session-multigrid-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelectorAll(".session-multigrid-cell")).toHaveLength(2);
  });

  it("hides the grid and shows the full launcher on Cmd+N when newSessionMode is 'full'", async () => {
    render(<App />);

    // Promote one workspace into the grid so the new-session toggle can do work.
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    expect(screen.getByRole("group", { name: "Session panes" })).toBeInTheDocument();

    // Flip the Defaults → New session toggle to "Open full view".
    await openSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Open full view" }));
    expect(window.localStorage.getItem("argmax.newSessionMode")).toBe("full");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await screen.findByRole("group", { name: "Session panes" });

    fireEvent.keyDown(document, { key: "n", metaKey: true });

    // Full launcher replaces the grid; no in-grid launcher cell is added.
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Session panes" })).toBeNull();
    expect(screen.queryByRole("region", { name: "New session for Argmax" })).toBeNull();

    // Esc dismisses the full launcher and restores the grid view.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("group", { name: "Session panes" })).toBeInTheDocument();
  });

  it("defaults the new-session toggle to 'Open full view' on first launch", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings();

    expect(await screen.findByRole("radio", { name: "Open full view" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Open in grid" })).not.toBeChecked();
    expect(window.localStorage.getItem("argmax.newSessionMode")).toBe("full");
  });

  it("opens the Cmd+N launcher below when the focused row already has 3 panes", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Second pane",
      branch: "argmax/second-pane",
      baseRef: "main",
      path: "/tmp/worktrees/second-pane",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const thirdWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-3",
      projectId: "project-1",
      taskLabel: "Third pane",
      branch: "argmax/third-pane",
      baseRef: "main",
      path: "/tmp/worktrees/third-pane",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:05:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Second pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    const thirdSession: DashboardSnapshot["sessions"][number] = {
      id: "session-3",
      workspaceId: "workspace-3",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-3",
      prompt: "Third pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:05:00.000Z",
      lastActivityAt: "2026-05-08T16:05:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace, thirdWorkspace],
      sessions: [...snapshot.sessions, secondSession, thirdSession]
    });

    window.localStorage.setItem("argmax.newSessionMode", "embedded");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.click(screen.getByRole("button", { name: "Second pane" }), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Third pane" }), { metaKey: true });
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(3);
    });

    fireEvent.keyDown(document, { key: "n", metaKey: true });

    expect(await screen.findByRole("region", { name: "New session for Argmax" })).toBeInTheDocument();
    const rows = document.querySelectorAll(".session-multigrid-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelectorAll(".session-multigrid-cell")).toHaveLength(3);
    expect(rows[1]?.querySelectorAll(".session-multigrid-cell")).toHaveLength(1);
  });

  it("highlights and drops a sidebar session even when dataTransfer payloads are empty", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Drop target",
      branch: "argmax/drop-target",
      baseRef: "main",
      path: "/tmp/worktrees/drop-target",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Drop target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    const dropTargetRow = screen.getByRole("button", { name: "Drop target" }).closest(".session-row-wrap");
    if (!(dropTargetRow instanceof HTMLElement)) throw new Error("Expected sidebar session row wrapper");

    fireEvent.dragStart(dropTargetRow, {
      dataTransfer: {
        setData: vi.fn(),
        setDragImage: vi.fn(),
        effectAllowed: "move"
      }
    });

    const dropOverlay = await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".multigrid-drop-overlay");
      if (!overlay) throw new Error("Expected drop overlay to render");
      return overlay;
    });
    Object.defineProperty(dropOverlay, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0, x: 0, y: 0, toJSON: () => ({}) })
    });

    const dataTransfer = {
      types: [],
      getData: vi.fn(() => ""),
      dropEffect: "move"
    };
    expect(document.querySelector('.multigrid-drop-zone[data-position="replace"]')).toBeNull();
    fireEvent.dragOver(dropOverlay, { clientX: 790, clientY: 300, dataTransfer });
    await waitFor(() => {
      expect(document.querySelector('.multigrid-drop-zone[data-hovered="true"]')).toBeInTheDocument();
    });

    fireEvent.drop(dropOverlay, { clientX: 790, clientY: 300, dataTransfer });

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(2);
    });
  });

  it("lets the user drag the divider between side-by-side panes to resize them", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Resize target",
      branch: "argmax/resize-target",
      baseRef: "main",
      path: "/tmp/worktrees/resize-target",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Resize target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.click(screen.getByRole("button", { name: "Resize target" }), { metaKey: true });

    const handle = await screen.findByRole("separator", { name: /Resize Build dashboard/ });
    const grid = screen.getByRole("group", { name: "Session panes" });
    const row = grid.firstElementChild;
    if (!(row instanceof HTMLElement)) throw new Error("Expected a grid row");
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1200, height: 600, top: 0, right: 1200, bottom: 600, left: 0, x: 0, y: 0, toJSON: () => ({}) })
    });
    const before = row.style.gridTemplateColumns;

    fireEvent.mouseDown(handle, { clientX: 450 });
    fireEvent.mouseMove(document, { clientX: 2000 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(row.style.gridTemplateColumns).not.toBe(before);
    });
    const frWidths = [...row.style.gridTemplateColumns.matchAll(/([\d.]+)fr/g)].map((match) =>
      Number(match[1])
    );
    expect(Math.min(...frWidths)).toBeGreaterThanOrEqual(MIN_RESIZABLE_CELL_WIDTH_PX - 1);
  });

  it("rebalances a row when adding another pane after a manual resize", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Wide pane",
      branch: "argmax/wide-pane",
      baseRef: "main",
      path: "/tmp/worktrees/wide-pane",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const thirdWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-3",
      projectId: "project-1",
      taskLabel: "Dropped pane",
      branch: "argmax/dropped-pane",
      baseRef: "main",
      path: "/tmp/worktrees/dropped-pane",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:05:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Wide pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    const thirdSession: DashboardSnapshot["sessions"][number] = {
      id: "session-3",
      workspaceId: "workspace-3",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-3",
      prompt: "Dropped pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:05:00.000Z",
      lastActivityAt: "2026-05-08T16:05:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace, thirdWorkspace],
      sessions: [...snapshot.sessions, secondSession, thirdSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.click(screen.getByRole("button", { name: "Wide pane" }), { metaKey: true });

    const handle = await screen.findByRole("separator", { name: /Resize Build dashboard/ });
    const grid = screen.getByRole("group", { name: "Session panes" });
    const row = grid.firstElementChild;
    if (!(row instanceof HTMLElement)) throw new Error("Expected a grid row");
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1200, height: 600, top: 0, right: 1200, bottom: 600, left: 0, x: 0, y: 0, toJSON: () => ({}) })
    });

    fireEvent.mouseDown(handle, { clientX: 450 });
    fireEvent.mouseMove(document, { clientX: 2000 });
    fireEvent.mouseUp(document);

    fireEvent.click(screen.getByRole("button", { name: "Dropped pane" }), { metaKey: true });

    await waitFor(() => {
      expect(row.querySelectorAll(".session-multigrid-cell")).toHaveLength(3);
      const frWidths = [...row.style.gridTemplateColumns.matchAll(/([\d.]+)fr/g)].map((match) =>
        Number(match[1])
      );
      expect(frWidths).toEqual([1, 1, 1]);
    });
  });

  it("⌘W closes the focused pane", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "CmdW target",
      branch: "argmax/cmd-w",
      baseRef: "main",
      path: "/tmp/worktrees/cmd-w",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      pinned: false
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Sonnet 5",
      modelId: "claude-sonnet-5",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "CmdW target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.click(screen.getByRole("button", { name: "CmdW target" }), { metaKey: true });
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(2);
    });

    fireEvent.keyDown(document, { key: "w", metaKey: true });

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Argmax" })).toHaveLength(1);
    });
  });

  it("toggles the focused session terminal from outside the chat view with Cmd+J", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.keyDown(document, { key: "j", metaKey: true });

    expect(await screen.findByRole("group", { name: "Session panes" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-collapsed", "false");
    });

    fireEvent.keyDown(document, { key: "j", metaKey: true });

    await waitFor(() => {
      expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-collapsed", "true");
    });
  });

  it("returns from Settings and opens the active session terminal on Cmd+J", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    await openSettings();

    fireEvent.keyDown(document, { key: "j", metaKey: true });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
      expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-collapsed", "false");
    });
  });
});
