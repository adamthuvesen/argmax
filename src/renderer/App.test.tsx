import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { ArgmaxApi, DashboardSnapshot } from "../shared/types.js";
import {
  archiveWorkspace,
  createCurrentWorkspace,
  dashboardDeltaListener,
  dashboardDeltaUnsubscribe,
  dashboardList,
  dashboardListSnapshot,
  launchProvider,
  listProjectFiles,
  mockDashboardSnapshot,
  pickProjectFolder,
  primaryProject,
  providersDiscover,
  secondProject,
  sessionEventsSince,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("renders the local project launcher from IPC data", async () => {
    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch model" })).toHaveTextContent("Claude Haiku 4.5");
    expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cockpit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("toggles project sessions in the sidebar and remembers collapsed projects", async () => {
    const { unmount } = render(<App />);

    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    const hideProjectSessions = screen.getByRole("button", { name: "Hide Argmax sessions" });
    fireEvent.click(hideProjectSessions);

    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Argmax sessions" })).toHaveAttribute("aria-expanded", "false");

    unmount();
    render(<App />);

    expect(await screen.findByRole("button", { name: "Show Argmax sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Argmax sessions" }));
    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("renders streamed dashboard deltas without reloading the full dashboard", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(dashboardList).toHaveBeenCalledTimes(1);

    act(() => {
      dashboardDeltaListener?.({
        events: [
          {
            id: "event-streamed",
            sessionId: "session-1",
            type: "message.delta",
            message: "Streaming now.",
            payload: {},
            createdAt: "2026-05-08T15:54:01.000Z"
          }
        ]
      });
    });

    expect(await screen.findByText("Streaming now.")).toBeInTheDocument();
    expect(dashboardList).toHaveBeenCalledTimes(1);
  });

  it("preserves the user's model selection across dashboard deltas for the same session", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    const modelButton = await screen.findByRole("button", { name: "Session model" });
    const initialLabel = modelButton.textContent ?? "";
    expect(initialLabel).toContain("GPT-5.3 Codex");

    // A delta that bumps lastActivityAt and reports a different modelLabel for
    // the same session id used to overwrite the user's local pick because the
    // effect depended on the session object reference. With the fix the effect
    // is gated on session.id, so the selector text must not change.
    const baseSession = snapshot.sessions[0];
    if (!baseSession) throw new Error("snapshot must include session-1");
    act(() => {
      dashboardDeltaListener?.({
        sessions: [
          {
            ...baseSession,
            modelLabel: "Claude Haiku 4.5",
            modelId: "claude-haiku-4-5",
            reasoningEffort: undefined,
            lastActivityAt: "2026-05-08T15:55:00.000Z"
          }
        ]
      });
    });

    const after = await screen.findByRole("button", { name: "Session model" });
    expect(after.textContent ?? "").toBe(initialLabel);
  });

  it("archives dirty shared-workspace sessions without confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sharedSnapshot: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        state: "complete",
        sharedWorkspace: true,
        path: "/tmp/argmax",
        dirty: true,
        changedFiles: 3
      })),
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    };
    mockDashboardSnapshot(sharedSnapshot);
    archiveWorkspace.mockResolvedValue({
      ...(sharedSnapshot.workspaces[0] ?? snapshot.workspaces[0]!),
      state: "archived"
    });

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Archive session" }));

      await waitFor(() =>
        expect(archiveWorkspace).toHaveBeenCalledWith({ workspaceId: "workspace-1", force: false })
      );
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("renders normalized tool calls in the conversation timeline", async () => {
    const toolStarted: DashboardSnapshot["events"][number] = {
      id: "event-tool-started",
      sessionId: "session-1",
      type: "command.started",
      message: "web_search",
      payload: {
        id: "ws_1",
        type: "web_search",
        name: "web_search",
        input: {}
      },
      createdAt: "2026-05-08T15:53:58.000Z"
    };
    const toolCompleted: DashboardSnapshot["events"][number] = {
      id: "event-tool-completed",
      sessionId: "session-1",
      type: "command.completed",
      message: "web_search",
      payload: {
        id: "ws_1",
        type: "web_search",
        name: "web_search",
        input: {
          query: "pizza recipe"
        }
      },
      createdAt: "2026-05-08T15:53:59.000Z"
    };
    mockDashboardSnapshot({
      ...snapshot,
      events: [snapshot.events[0], toolCompleted, toolStarted]
    });
    sessionEventsSince.mockResolvedValue({
      events: [snapshot.events[0], toolCompleted, toolStarted],
      rawOutputs: [],
      eventCursor: 3,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "Searched for pizza recipe" })).toBeInTheDocument();
    expect(screen.getByText("Dashboard ready.")).toBeInTheDocument();
  });

  it("keeps tool calls visible after a streaming assistant response completes", async () => {
    const toolStarted: DashboardSnapshot["events"][number] = {
      id: "event-tool-started",
      sessionId: "session-1",
      type: "command.started",
      message: "Read",
      payload: { id: "tu_1", type: "Read", name: "Read", input: { file_path: "README.md" } },
      createdAt: "2026-05-08T15:53:50.000Z"
    };
    const toolCompleted: DashboardSnapshot["events"][number] = {
      id: "event-tool-completed",
      sessionId: "session-1",
      type: "command.completed",
      message: "tool_result",
      payload: { tool_use_id: "tu_1", content: "file body" },
      createdAt: "2026-05-08T15:53:51.000Z"
    };
    const streamingDeltas: DashboardSnapshot["events"] = Array.from({ length: 120 }, (_, i) => ({
      id: `event-delta-${i}`,
      sessionId: "session-1",
      type: "message.delta" as const,
      message: `chunk ${i}`,
      payload: {},
      createdAt: new Date(Date.parse("2026-05-08T15:53:52.000Z") + i).toISOString()
    }));
    const messageCompleted: DashboardSnapshot["events"][number] = {
      id: "event-msg-completed",
      sessionId: "session-1",
      type: "message.completed",
      message: "All set.",
      payload: {},
      createdAt: "2026-05-08T15:54:00.000Z"
    };

    const firstEvent = snapshot.events[0];
    if (!firstEvent) throw new Error("test fixture missing baseline event");
    const eventsBundle = [firstEvent, toolStarted, toolCompleted, ...streamingDeltas, messageCompleted];
    mockDashboardSnapshot({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "Read README.md" })).toBeInTheDocument();
    expect(screen.getByText("All set.")).toBeInTheDocument();
  });

  it("renders a tool-call group between two assistant messages with overlapping timestamps", async () => {
    const userMessage: DashboardSnapshot["events"][number] = {
      id: "ev-user-explore",
      sessionId: "session-1",
      type: "user.message",
      message: "yes explore the codebase",
      payload: {},
      createdAt: "2026-05-08T15:56:43.000Z"
    };
    const announce: DashboardSnapshot["events"][number] = {
      id: "ev-msg-announce",
      sessionId: "session-1",
      type: "message.completed",
      message: "I'll explore the codebase.",
      payload: {},
      createdAt: "2026-05-08T15:56:49.000Z"
    };
    // First two tool starts share the announce timestamp.
    const toolEvents: DashboardSnapshot["events"] = [
      { id: "ev-glob-1-s", sessionId: "session-1", type: "command.started", message: "Glob",
        payload: { id: "tu1", name: "Glob", input: { pattern: "src/**/*.py" } },
        createdAt: "2026-05-08T15:56:49.000Z" },
      { id: "ev-glob-1-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu1", content: "match" }, createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-glob-2-s", sessionId: "session-1", type: "command.started", message: "Glob",
        payload: { id: "tu2", name: "Glob", input: { pattern: "src/**/*.ts" } },
        createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-glob-2-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu2", content: "match" }, createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-read-1-s", sessionId: "session-1", type: "command.started", message: "Read",
        payload: { id: "tu3", name: "Read", input: { file_path: "README.md" } },
        createdAt: "2026-05-08T15:56:50.000Z" },
      { id: "ev-read-1-c", sessionId: "session-1", type: "command.completed", message: "tool_result",
        payload: { tool_use_id: "tu3", content: "file" }, createdAt: "2026-05-08T15:56:52.000Z" }
    ];
    const finalAnswer: DashboardSnapshot["events"][number] = {
      id: "ev-msg-final",
      sessionId: "session-1",
      type: "message.completed",
      message: "I've explored.",
      payload: {},
      createdAt: "2026-05-08T15:57:25.000Z"
    };

    const eventsBundle = [userMessage, announce, ...toolEvents, finalAnswer];
    mockDashboardSnapshot({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    // Assistant message text is tokenized into separate <span> elements once
    // shiki's highlighter caches across tests (same module-state quirk that
    // P6.01 hit). Wait for the conversation surface to render, then assert
    // against its concatenated textContent so tokenization is invisible.
    const conversation = await screen.findByRole("region", { name: "Session conversation" });
    await waitFor(() => expect(conversation).toHaveTextContent("I'll explore the codebase."));
    expect(conversation).toHaveTextContent("I've explored.");
    expect(screen.getByRole("button", { name: /Explored 1 file, 2 searches/ })).toBeInTheDocument();
  });

  it("hides provider protocol JSON from the first-turn raw transcript fallback", async () => {
    const lifecycleSnapshot: DashboardSnapshot = {
      ...snapshot,
      events: [],
      rawOutputs: [
        {
          id: "raw-lifecycle",
          sessionId: "session-1",
          stream: "stdout",
          content:
            '{"type":"thread.started","thread_id":"019e0bd0-7694-7032-85cd-f670d78ac282"}\n{"type":"turn.started"}\n{"type":"init","cwd":"/tmp/argmax","session_id":"claude-session","tools":["Task","Bash"]}\n',
          createdAt: "2026-05-08T15:54:01.000Z"
        }
      ]
    };
    mockDashboardSnapshot(lifecycleSnapshot);
    sessionEventsSince.mockResolvedValue({
      events: [],
      rawOutputs: lifecycleSnapshot.rawOutputs,
      eventCursor: 0,
      rawOutputCursor: 1
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.queryByText(/thread\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/turn\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"tools"/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("unsubscribes from dashboard deltas on unmount", async () => {
    const rendered = render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    rendered.unmount();

    expect(dashboardDeltaUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not schedule focused dashboard polling while work is active", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    try {
      render(<App />);

      expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1200);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("starts the default provider from the composer", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Switch model" })).toHaveTextContent("Claude Haiku 4.5");
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement PTY launch" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createCurrentWorkspace).toHaveBeenCalledWith({
        projectId: "project-1",
        taskLabel: "Implement PTY launch"
      })
    );
    expect(launchProvider).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "claude",
      prompt: "Implement PTY launch",
      modelLabel: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      reasoningEffort: null,
      agentMode: "auto",
      permissionMode: "auto-approve",
      cols: 120,
      rows: 32,
      attachments: null
    });
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
  });

  it("toggles launcher agent mode with Shift+Tab and sends plan mode", async () => {
    render(<App />);

    const input = await screen.findByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "Plan the migration" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Plan");
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Plan the migration",
          agentMode: "plan"
        })
      )
    );
    expect(window.localStorage.getItem("argmax.launch.agentMode")).toBeNull();
  });

  it("starts new sessions in auto mode even when the old launcher preference was plan", async () => {
    window.localStorage.setItem("argmax.launch.agentMode", "plan");

    render(<App />);

    expect(await screen.findByRole("button", { name: "Agent mode" })).toHaveTextContent("Auto");
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Implement the thing" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Implement the thing",
          agentMode: "auto"
        })
      )
    );
  });

  it("keeps a newly launched chat selected while the dashboard refresh catches up", async () => {
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-new",
      projectId: "project-1",
      taskLabel: "New chat",
      branch: "main",
      baseRef: "main",
      path: "/tmp/argmax",
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
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "New chat",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
    };
    const newEvent: DashboardSnapshot["events"][number] = {
      id: "event-new",
      sessionId: "session-new",
      type: "message.completed",
      message: "New chat answer.",
      payload: {},
      createdAt: "2026-05-08T16:10:01.000Z"
    };
    mockDashboardSnapshot(snapshot);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-new") {
        return Promise.resolve({ events: [newEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: snapshot.rawOutputs, eventCursor: 1, rawOutputCursor: 0 });
    });
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "New chat" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    act(() => {
      dashboardDeltaListener?.({
        workspaces: [newWorkspace],
        sessions: [newSession],
        events: [newEvent]
      });
    });

    expect(await screen.findByText("New chat answer.")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toHaveAttribute("aria-current", "true");
  });

  it("displays an @-mention-only launch prompt as the user message in the new session", async () => {
    listProjectFiles.mockResolvedValue([{ path: "AGENTS.md" }]);
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-mention",
      projectId: "project-1",
      taskLabel: "@AGENTS.md",
      branch: "main",
      baseRef: "main",
      path: "/tmp/argmax",
      state: "running",
      sharedWorkspace: true,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      pinned: false
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-mention",
      workspaceId: "workspace-mention",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      permissionMode: "auto-approve",
      providerConversationId: null,
      prompt: "@AGENTS.md",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
    };
    const userEvent: DashboardSnapshot["events"][number] = {
      id: "event-user-mention",
      sessionId: "session-mention",
      type: "user.message",
      message: "@AGENTS.md",
      payload: { source: "composer", agentMode: "auto" },
      createdAt: "2026-05-08T16:10:00.500Z"
    };
    mockDashboardSnapshot(snapshot);
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-mention") {
        return Promise.resolve({ events: [userEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: snapshot.rawOutputs, eventCursor: 1, rawOutputCursor: 0 });
    });
    createCurrentWorkspace.mockResolvedValue(newWorkspace);
    launchProvider.mockResolvedValue(newSession);

    render(<App />);

    const promptInput = await screen.findByLabelText("Task prompt");
    fireEvent.change(promptInput, { target: { value: "@AGENTS.md" } });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "@AGENTS.md" })
      )
    );
    act(() => {
      dashboardDeltaListener?.({
        workspaces: [newWorkspace],
        sessions: [newSession],
        events: [userEvent]
      });
    });

    const bubble = await screen.findByText("@AGENTS.md", { selector: "p" });
    expect(bubble.closest(".chat-bubble.user")).not.toBeNull();
  });

  it("starts Claude when selected in the composer", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
    const launchPopover = await screen.findByRole("listbox", { name: "Switch model" });
    // Sonnet is effort-capable, so picking it seeds the default Medium effort.
    fireEvent.click(within(launchPopover).getByText("Claude Sonnet 4.6"));
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Review this change" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        provider: "claude",
        prompt: "Review this change",
        modelLabel: "Claude Sonnet 4.6",
        modelId: "claude-sonnet-4-6",
        reasoningEffort: "medium",
        agentMode: "auto",
        permissionMode: "auto-approve",
        cols: 120,
        rows: 32,
        attachments: null
      })
    );
  });

  it("dismisses the model picker when clicking non-option popover content", async () => {
    render(<App />);

    const modelToggle = await screen.findByRole("button", { name: "Switch model" });
    fireEvent.click(modelToggle);
    expect(modelToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByText("Codex"));
    expect(modelToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses the branch picker when clicking inside the popover chrome", async () => {
    render(<App />);

    const branchToggle = await screen.findByRole("button", { name: "Switch branch" });
    fireEvent.click(branchToggle);
    await waitFor(() => expect(branchToggle).toHaveAttribute("aria-expanded", "true"));

    fireEvent.click(await screen.findByRole("listbox", { name: "Select branch" }));
    expect(branchToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses open pickers via the global dismiss layer", async () => {
    render(<App />);

    const modelToggle = await screen.findByRole("button", { name: "Switch model" });
    fireEvent.click(modelToggle);
    expect(modelToggle).toHaveAttribute("aria-expanded", "true");

    const dismissLayer = document.querySelector(".picker-dismiss-layer");
    expect(dismissLayer).toBeInTheDocument();
    fireEvent.mouseDown(dismissLayer as Element);

    expect(modelToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("adds a second project, selects it, and launches from that project", async () => {
    const dotfilesProject = secondProject();
    pickProjectFolder.mockResolvedValue({ cancelled: false, project: dotfilesProject });

    render(<App />);

    // Wait for the initial dashboard load to settle so the post-mount loadState
    // transition can't race with addProject and overwrite the merged snapshot.
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("button", { name: "Dotfiles" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByText("Added Dotfiles.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Update shell aliases" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(createCurrentWorkspace).toHaveBeenCalledWith({
        projectId: "project-2",
        taskLabel: "Update shell aliases"
      })
    );
  });

  it("leaves state unchanged when folder selection is cancelled", async () => {
    pickProjectFolder.mockResolvedValue({ cancelled: true });

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalledTimes(1));
    expect(dashboardList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("shows a clear error when folder registration fails", async () => {
    pickProjectFolder.mockRejectedValue(new Error("Argmax requires a local git repository."));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Argmax requires a local git repository.");
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("renders the WelcomePane before any projects are registered and gates the CTA on provider discovery", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      projects: [],
      workspaces: [],
      sessions: [],
      events: []
    });
    // Empty discovery: the launcher CTA stays disabled until at least one
    // provider is detected — Argmax can't launch a session without a CLI.
    providersDiscover.mockResolvedValue([]);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to Argmax" })).toBeInTheDocument();
    expect(screen.queryByTitle("Start agent")).not.toBeInTheDocument();

    // Two "Add Project" buttons exist: the sidebar's (always enabled) and the
    // launcher CTA inside WelcomePane (gated on discovery). Pick the launcher
    // one and assert it is disabled until a provider is detected.
    const launcherCta = await screen.findByTitle("Install at least one provider CLI first");
    expect(launcherCta).toHaveAttribute("aria-disabled", "true");
    expect(launcherCta).toBeDisabled();
  });

  it("enables the WelcomePane CTA once at least one provider is detected", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      projects: [],
      workspaces: [],
      sessions: [],
      events: []
    });
    providersDiscover.mockResolvedValue([
      {
        provider: "claude",
        displayName: "Claude Code",
        binaryName: "claude",
        installed: true,
        binaryPath: "/usr/local/bin/claude",
        version: "1.2.3",
        modes: ["structured-json"],
        setupGuidance: null
      }
    ]);

    render(<App />);

    await screen.findByRole("heading", { name: "Welcome to Argmax" });
    // Once discovery resolves with an installed provider, the launcher CTA
    // switches to the "Pick a local git repository" title and becomes enabled.
    const launcherCta = await screen.findByTitle("Pick a local git repository");
    expect(launcherCta).not.toBeDisabled();
  });


  it("renders the dashboard error state with a Retry button and reloads on click", async () => {
    let attempts = 0;
    dashboardList.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("backend-fault"));
      }
      return Promise.resolve(dashboardListSnapshot(snapshot));
    });

    render(<App />);

    expect(await screen.findByText(/backend-fault/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });


  it("keeps error toasts past the 4s auto-dismiss window", async () => {
    pickProjectFolder.mockRejectedValueOnce(new Error("Pick a real git repo."));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

      fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
      const errorMessage = await screen.findByText("Pick a real git repo.");

      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(errorMessage).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-dismisses info toasts after the 4s window", async () => {
    pickProjectFolder.mockResolvedValueOnce({ cancelled: false, project: primaryProject() });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

      fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
      await screen.findByText(/Added /);

      // Flush React's post-commit effect that schedules the dismiss setTimeout
      // before advancing fake timers; otherwise the timer is scheduled from a
      // later fake-clock instant and never fires within the waitFor window.
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      await waitFor(() => expect(screen.queryByText(/Added /)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App without preload bridge", () => {
  it("renders the bridge-missing banner when window.argmax is undefined", async () => {
    const previousArgmax = window.argmax;
    delete (window as { argmax?: ArgmaxApi }).argmax;

    // jsdom marks Location.prototype.hostname non-configurable, so swap the
    // entire `window.location` with a plain stub for the duration of the test.
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hostname: "example.test", host: "example.test" }
    });

    try {
      render(<App />);
      expect(
        await screen.findByText(/Preload bridge unavailable; running on demo data/)
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation
      });
      window.argmax = previousArgmax;
    }
  });

  it("uses demo data without the bridge-missing banner in browser preview", async () => {
    const previousArgmax = window.argmax;
    delete (window as { argmax?: ArgmaxApi }).argmax;

    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, hostname: "127.0.0.1", host: "127.0.0.1:5173" }
    });

    try {
      render(<App />);

      expect(
        screen.queryByText(/Preload bridge unavailable; running on demo data/)
      ).not.toBeInTheDocument();
      expect(await screen.findByText("Design parallel agent board")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation
      });
      window.argmax = previousArgmax;
    }
  });
});
