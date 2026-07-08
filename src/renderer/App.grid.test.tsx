import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { MIN_RESIZABLE_CELL_WIDTH_PX } from "./components/SessionMultiGrid.js";
import type { DashboardSnapshot, SessionEventsSinceResult } from "../shared/types.js";
import {
  createCurrentWorkspace,
  dashboardDeltaListener,
  launchProvider,
  mockDashboardSnapshot,
  openSettings,
  sessionAgentEvents,
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
    vi.useRealTimers();
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

  it("keeps the current session and opens a launcher pane to the right from New Agent", async () => {
    window.localStorage.setItem("argmax.newSessionMode", "embedded");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    fireEvent.click(screen.getByRole("button", { name: "New Agent" }));

    expect(await screen.findByRole("region", { name: "New session for Argmax" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Build dashboard" })).toBeInTheDocument();
    const rows = document.querySelectorAll(".session-multigrid-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelectorAll(".session-multigrid-cell")).toHaveLength(2);
  });

  it("opens an agent activity pane from an agent row without showing child prose in the parent chat", async () => {
    const promptText = "Find the renderer entry points and note the important files before reporting back. ".repeat(9).trim();
    const data: DashboardSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete" as const,
        completedAt: "2026-05-08T15:55:00.000Z"
      })),
      events: [
        {
          id: "task-result",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "task-1", content: "**Agent finished.**\n\n1. Parser found." },
          createdAt: "2026-05-08T15:54:04.000Z"
        },
        {
          id: "child-message",
          sessionId: "session-1",
          type: "message.completed",
          message: "Subagent found parser.",
          payload: { parent_tool_use_id: "task-1" },
          createdAt: "2026-05-08T15:54:03.000Z"
        },
        {
          id: "child-prompt-echo",
          sessionId: "session-1",
          type: "message.completed",
          message: promptText,
          payload: { parent_tool_use_id: "task-1" },
          createdAt: "2026-05-08T15:54:02.500Z"
        },
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: promptText
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "parent-message",
          sessionId: "session-1",
          type: "message.completed",
          message: "I will delegate this.",
          payload: {},
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    };
    mockDashboardSnapshot(data);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByText("I will delegate this.");
    expect(screen.queryByText("Subagent found parser.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Started agent Map renderer" }));

    const pane = await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    expect(within(pane).getByText("Subagent")).toBeInTheDocument();
    expect(within(pane).queryByRole("heading", { name: "Map renderer" })).toBeNull();
    expect(within(pane).getAllByText(promptText)).toHaveLength(1);
    const expandInstructions = within(pane).getByRole("button", { name: "Expand instructions" });
    expect(expandInstructions).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expandInstructions);
    expect(within(pane).getByRole("button", { name: "Collapse instructions" })).toHaveAttribute("aria-expanded", "true");
    const childMessage = within(pane).getByText("Subagent found parser.");
    const result = within(pane).getByRole("region", { name: "Agent result" });
    expect(childMessage.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(result).getByText("Agent finished.").tagName).toBe("STRONG");
    expect(within(result).getByText("Parser found.")).toBeInTheDocument();
    expect(sessionAgentEvents).toHaveBeenCalledWith({ sessionId: "session-1", parentToolUseId: "task-1" });
  });

  it("dismisses an agent pane when sidebar navigation replaces its parent session", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Follow up task",
      branch: "argmax/follow-up",
      baseRef: "main",
      path: "/tmp/worktrees/follow-up",
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
      prompt: "Follow up task",
      state: "complete",
      attention: "normal",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession],
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    expect(await screen.findByRole("region", { name: "Agent activity for Build dashboard" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Follow up task" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Agent activity for Build dashboard" })).toBeNull();
    });
    expect(screen.queryByRole("region", { name: "Build dashboard" })).toBeNull();
    const grid = screen.getByRole("group", { name: "Session panes" });
    expect(within(grid).getAllByRole("group", { name: /^Pane row/ })).toHaveLength(1);
    expect(within(grid).getAllByRole("region", { name: "Follow up task" })).toHaveLength(1);
  });

  it("renders imported child tool rows instead of the limited-data notice", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete" as const,
        completedAt: "2026-05-08T15:55:00.000Z"
      })),
      events: [
        {
          id: "child-read-complete",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: {
            id: "trace-read-1",
            parent_tool_use_id: "task-1",
            traceImported: true,
            traceNoOutput: true
          },
          createdAt: "2026-05-08T15:54:03.500Z"
        },
        {
          id: "child-read",
          sessionId: "session-1",
          type: "command.started",
          message: "Read",
          payload: {
            id: "trace-read-1",
            name: "Read",
            parent_tool_use_id: "task-1",
            traceImported: true,
            input: { file_path: "src/renderer/App.tsx" }
          },
          createdAt: "2026-05-08T15:54:03.000Z"
        },
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));

    const pane = await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    expect(within(pane).getByRole("button", { name: "Read App.tsx" })).toBeInTheDocument();
    expect(within(pane).queryByText("This provider reported the agent launch, but did not stream child activity.")).toBeNull();
  });

  it("renders the agent instructions prompt as markdown", async () => {
    const promptText = [
      "Find the **renderer** entry points.",
      "",
      "- Read `src/renderer/App.tsx` first.",
      "- Keep it short."
    ].join("\n");
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete" as const,
        completedAt: "2026-05-08T15:55:00.000Z"
      })),
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: promptText
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));

    const pane = await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    expect(within(pane).getByText("renderer").tagName).toBe("STRONG");
    expect(within(pane).getByRole("button", { name: "Open src/renderer/App.tsx" })).toBeInTheDocument();
    expect(within(pane).getByText("Keep it short.").tagName).toBe("LI");
  });

  it("keeps a running spawn's pane through a same-prompt retry and drops it once the session stops", async () => {
    const prompt = "Map renderer";
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        {
          id: "failed-start",
          sessionId: "session-1",
          type: "command.started",
          message: "spawn_agent",
          payload: {
            id: "item_1",
            name: "spawn_agent",
            input: {
              prompt,
              receiver_thread_ids: [],
              sender_thread_id: "thread-parent"
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    expect(await screen.findByRole("region", { name: "Agent activity for Build dashboard" })).toBeInTheDocument();

    await act(async () => {
      dashboardDeltaListener?.({
        events: [
          {
            id: "retry-end",
            sessionId: "session-1",
            type: "command.completed",
            message: "spawn_agent",
            payload: {
              id: "item_2",
              name: "spawn_agent",
              status: "completed",
              input: {
                prompt,
                receiver_thread_ids: ["thread-child"],
                sender_thread_id: "thread-parent"
              }
            },
            createdAt: "2026-05-08T15:54:05.000Z"
          },
          {
            id: "retry-start",
            sessionId: "session-1",
            type: "command.started",
            message: "spawn_agent",
            payload: {
              id: "item_2",
              name: "spawn_agent",
              input: {
                prompt,
                receiver_thread_ids: [],
                sender_thread_id: "thread-parent"
              }
            },
            createdAt: "2026-05-08T15:54:04.000Z"
          }
        ]
      });
      await Promise.resolve();
    });

    // While the parent session runs, the earlier spawn may be a live parallel
    // agent — the retry completing must not hide it or force-close its pane.
    expect(screen.getByRole("region", { name: "Agent activity for Build dashboard" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Started agent Map renderer" })).toHaveLength(2);

    await act(async () => {
      dashboardDeltaListener?.({
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          state: "complete" as const,
          completedAt: "2026-05-08T15:54:06.000Z"
        }))
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Agent activity for Build dashboard" })).toBeNull();
    });
    expect(screen.getAllByRole("button", { name: "Started agent Map renderer" })).toHaveLength(1);
  });

  it("polls agent events while an agent pane is still running", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    await waitFor(() => {
      expect(sessionAgentEvents).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(sessionAgentEvents).toHaveBeenCalledTimes(2);
    }, { timeout: 2500 });
  });

  it("keeps Thinking after an empty backfill while the agent is still running", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });
    let resolveAgentEvents!: (value: SessionEventsSinceResult) => void;
    sessionAgentEvents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAgentEvents = resolve;
          })
      )
      .mockResolvedValue({ events: [], rawOutputs: [], eventCursor: 0, rawOutputCursor: 0 });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));

    const pane = await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    expect(within(pane).getByTestId("thinking-label")).toHaveTextContent("Thinking");
    expect(within(pane).queryByText("This provider reported the agent launch, but did not stream child activity.")).toBeNull();

    await act(async () => {
      resolveAgentEvents({ events: [], rawOutputs: [], eventCursor: 0, rawOutputCursor: 0 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(within(pane).getByTestId("thinking-label")).toHaveTextContent("Thinking");
    });
    expect(within(pane).queryByText("This provider reported the agent launch, but did not stream child activity.")).toBeNull();
  });

  it("shows the limited-data notice only after an agent finishes without child activity", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete" as const,
        completedAt: "2026-05-08T15:55:00.000Z"
      })),
      events: [
        {
          id: "task-result",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "task-1", content: "Done without child stream." },
          createdAt: "2026-05-08T15:54:04.000Z"
        },
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));

    const pane = await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    expect(within(pane).queryByTestId("thinking-label")).toBeNull();
    expect(within(pane).getByText("This provider reported the agent launch, but did not stream child activity.")).toBeInTheDocument();
    expect(within(pane).getByText("Done without child stream.")).toBeInTheDocument();
  });

  it("does not overlap agent event polls while the prior load is in flight", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });
    let resolveAgentEvents!: (value: SessionEventsSinceResult) => void;
    sessionAgentEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAgentEvents = resolve;
        })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    await waitFor(() => {
      expect(sessionAgentEvents).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1700));
    });

    expect(sessionAgentEvents).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAgentEvents({ events: [], rawOutputs: [], eventCursor: 0, rawOutputCursor: 0 });
      await Promise.resolve();
    });
  });

  it("does not poll agent events after the parent session and agent are done", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete" as const,
        completedAt: "2026-05-08T15:55:00.000Z"
      })),
      events: [
        {
          id: "task-result",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "task-1", content: "Done." },
          createdAt: "2026-05-08T15:54:04.000Z"
        },
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        },
        {
          id: "user-message",
          sessionId: "session-1",
          type: "user.message",
          message: "Map this",
          payload: {},
          createdAt: "2026-05-08T15:54:00.000Z"
        }
      ]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    await screen.findByRole("region", { name: "Agent activity for Build dashboard" });
    await waitFor(() => {
      expect(sessionAgentEvents).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1700));
    });

    expect(sessionAgentEvents).toHaveBeenCalledTimes(1);
  });

  it("clears stale agent panes after launching from the full new-session surface", async () => {
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-new",
      projectId: "project-1",
      taskLabel: "Fresh task",
      branch: "argmax/fresh-task",
      baseRef: "main",
      path: "/tmp/worktrees/fresh-task",
      state: "running",
      sharedWorkspace: true,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      pinned: false
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-new",
      workspaceId: "workspace-new",
      provider: "claude",
      modelLabel: "Opus 4.8",
      modelId: "claude-opus-4-8",
      permissionMode: "auto-approve",
      providerConversationId: "session-new",
      prompt: "Fresh task",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z"
    };
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        {
          id: "task-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "task-1",
            name: "Task",
            input: {
              description: "Map renderer",
              prompt: "Find renderer files."
            }
          },
          createdAt: "2026-05-08T15:54:02.000Z"
        }
      ]
    });
    window.localStorage.setItem("argmax.newSessionMode", "full");

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Started agent Map renderer" }));
    expect(await screen.findByRole("region", { name: "Agent activity for Build dashboard" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "n", metaKey: true });
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Fresh task" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Agent activity for Build dashboard" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Fresh task" })).toBeInTheDocument();
    const grid = screen.getByRole("group", { name: "Session panes" });
    expect(within(grid).getAllByRole("group", { name: /^Pane row/ })).toHaveLength(1);
    expect(within(grid).getAllByRole("region", { name: "Fresh task" })).toHaveLength(1);
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
    fireEvent.keyDown(document, { key: ",", metaKey: true });
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
