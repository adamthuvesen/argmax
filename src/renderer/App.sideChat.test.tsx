import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { SessionSummary, WorkspaceSummary } from "../shared/types.js";
import {
  archiveWorkspace,
  createScratchWorkspace,
  dashboardDeltaListener,
  launchProvider,
  mockDashboardSnapshot,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App side chat launcher", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("launches a repo-less side chat from Chat on the mode chip", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });

    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Chat");
    expect(await screen.findByText("New side chat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch branch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Worktree" })).toBeNull();

    fireEvent.change(input, {
      target: { value: "Explain vector clocks" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(createScratchWorkspace).toHaveBeenCalledTimes(1));
    expect(createScratchWorkspace).toHaveBeenCalledWith({
      taskLabel: "Explain vector clocks",
      kind: null
    });
    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Explain vector clocks",
      agentMode: "auto"
    });
  });

  it("returns to a project session when cycling Chat back to Auto", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    await screen.findByText("New side chat");

    fireEvent.keyDown(input, { key: "Tab" });

    expect(await screen.findByText("New chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Auto");
    expect(screen.getByRole("button", { name: "Switch project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch branch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Worktree" })).toBeInTheDocument();
  });

  it("keeps Chat out of the project picker", async () => {
    render(<App />);
    await screen.findByLabelText("Task prompt");

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    const picker = screen.getByRole("listbox", { name: "Select project" });
    expect(within(picker).queryByRole("button", { name: "Chat" })).toBeNull();
  });

  it("opens the launcher pre-set to chat mode from the sidebar's New side chat", async () => {
    render(<App />);
    await screen.findByLabelText("Task prompt");
    expect(screen.queryByText("New side chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New side chat" }));

    expect(await screen.findByText("New side chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Chat");
  });

  it("archives stray details-popup workspaces on boot", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          id: "workspace-stray-popup",
          projectId: "scratch-side-chats",
          taskLabel: "More details",
          branch: "main",
          baseRef: "main",
          path: "/tmp/side-chats/workspace-stray-popup",
          state: "complete",
          sharedWorkspace: true,
          kind: "popup",
          dirty: false,
          changedFiles: 0,
          lastActivityAt: "2026-05-08T15:54:00.000Z",
          pinned: false,
          priorityDismissedAt: null,
          priorityAddedAt: null
        }
      ]
    });

    render(<App />);
    await screen.findByLabelText("Task prompt");

    await waitFor(() =>
      expect(archiveWorkspace).toHaveBeenCalledWith({
        workspaceId: "workspace-stray-popup",
        force: true
      })
    );
  });

  it("never sweeps the details popup it is mid-launching when its delta lands early", async () => {
    // The backend publishes the scratch row before createScratch returns, so a
    // dashboard delta can arrive while providers.launch is still awaited. The
    // sweep must treat that row as claimed, not as a crash stray.
    const popupWorkspace: WorkspaceSummary = {
      ...snapshot.workspaces[0],
      id: "workspace-popup-live",
      projectId: "scratch-side-chats",
      taskLabel: "More details",
      path: "/tmp/side-chats/workspace-popup-live",
      state: "created",
      sharedWorkspace: true,
      kind: "popup"
    };
    createScratchWorkspace.mockResolvedValue(popupWorkspace);
    let resolveLaunch: ((session: SessionSummary) => void) | null = null;
    launchProvider.mockImplementation(
      () => new Promise<SessionSummary>((resolve) => (resolveLaunch = resolve))
    );

    // jsdom implements Range selection but not layout measurement.
    Range.prototype.getBoundingClientRect = () =>
      ({ left: 40, top: 200, right: 240, bottom: 216, width: 200, height: 16, x: 40, y: 200, toJSON: () => ({}) });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const bubbleText = await screen.findByText("Dashboard ready.");

    const range = document.createRange();
    range.selectNodeContents(bubbleText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    fireEvent.click(
      await screen.findByRole("button", { name: "Explain selection in more detail" })
    );
    await waitFor(() => expect(createScratchWorkspace).toHaveBeenCalledTimes(1));

    // The early delta arrives while providers.launch is still pending.
    act(() => {
      dashboardDeltaListener?.({ workspaces: [popupWorkspace] });
    });
    expect(archiveWorkspace).not.toHaveBeenCalled();

    const popupSession: SessionSummary = {
      ...snapshot.sessions[0],
      id: "session-popup-live",
      workspaceId: "workspace-popup-live"
    };
    await act(async () => {
      resolveLaunch?.(popupSession);
      await Promise.resolve();
    });

    expect(await screen.findByRole("dialog", { name: "More details" })).toBeInTheDocument();
    expect(archiveWorkspace).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
  });
});
