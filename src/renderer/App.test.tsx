import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { DashboardDelta, DashboardSnapshot, MaestroApi } from "../shared/types.js";

const snapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Maestro",
      repoPath: "/tmp/maestro",
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex",
        worktreeLocation: "/tmp/worktrees",
        setupCommand: "npm install",
        checkCommands: ["npm test"]
      },
      counts: {
        active: 1,
        blocked: 0,
        failed: 0,
        reviewReady: 1
      },
      latestActivityAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  workspaces: [
    {
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Build dashboard",
      branch: "maestro/dashboard",
      baseRef: "main",
      path: "/tmp/worktrees/dashboard",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 3,
      lastActivityAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  sessions: [
    {
      id: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      providerConversationId: null,
      prompt: "Build dashboard",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T15:30:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      preferred: false
    }
  ],
  events: [
    {
      id: "event-1",
      sessionId: "session-1",
      type: "message.completed",
      message: "Dashboard ready.",
      payload: {},
      createdAt: "2026-05-08T15:54:00.000Z"
    }
  ],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
};

function dashboardListSnapshot(data: DashboardSnapshot): Awaited<ReturnType<MaestroApi["dashboard"]["list"]>> {
  return {
    projects: data.projects,
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

function workspaceStatusSnapshot(data: DashboardSnapshot): Awaited<ReturnType<MaestroApi["workspaces"]["status"]>> {
  return {
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

describe("App", () => {
  let createCurrentWorkspace: ReturnType<typeof vi.fn<MaestroApi["workspaces"]["createCurrent"]>>;
  let dashboardLoad: ReturnType<typeof vi.fn<MaestroApi["dashboard"]["load"]>>;
  let dashboardList: ReturnType<typeof vi.fn<MaestroApi["dashboard"]["list"]>>;
  let dashboardDeltaListener: ((delta: DashboardDelta) => void) | null;
  let dashboardDeltaUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
  let launchProvider: ReturnType<typeof vi.fn<MaestroApi["providers"]["launch"]>>;
  let approvalsPending: ReturnType<typeof vi.fn<MaestroApi["approvals"]["pending"]>>;
  let pickProjectFolder: ReturnType<typeof vi.fn<MaestroApi["projects"]["pickFolder"]>>;
  let listChangedFiles: ReturnType<typeof vi.fn<MaestroApi["review"]["listChangedFiles"]>>;
  let loadDiff: ReturnType<typeof vi.fn<MaestroApi["review"]["loadDiff"]>>;
  let sessionEventsSince: ReturnType<typeof vi.fn<MaestroApi["session"]["eventsSince"]>>;
  let sendProviderInput: ReturnType<typeof vi.fn<MaestroApi["providers"]["sendInput"]>>;
  let workspaceStatus: ReturnType<typeof vi.fn<MaestroApi["workspaces"]["status"]>>;
  let skillsList: ReturnType<typeof vi.fn<MaestroApi["skills"]["list"]>>;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.localStorage.clear();
    createCurrentWorkspace = vi.fn<MaestroApi["workspaces"]["createCurrent"]>().mockResolvedValue(
      snapshot.workspaces[0] ?? missingWorkspace()
    );
    dashboardLoad = vi.fn<MaestroApi["dashboard"]["load"]>().mockResolvedValue(snapshot);
    dashboardList = vi.fn<MaestroApi["dashboard"]["list"]>().mockResolvedValue(dashboardListSnapshot(snapshot));
    dashboardDeltaListener = null;
    dashboardDeltaUnsubscribe = vi.fn<() => void>();
    launchProvider = vi.fn<MaestroApi["providers"]["launch"]>().mockResolvedValue(snapshot.sessions[0] ?? missingSession());
    approvalsPending = vi.fn<MaestroApi["approvals"]["pending"]>().mockResolvedValue(snapshot.approvals);
    pickProjectFolder = vi.fn<MaestroApi["projects"]["pickFolder"]>().mockResolvedValue({
      cancelled: false,
      project: primaryProject()
    });
    sessionEventsSince = vi.fn<MaestroApi["session"]["eventsSince"]>().mockResolvedValue({
      events: snapshot.events,
      rawOutputs: snapshot.rawOutputs,
      eventCursor: 0,
      rawOutputCursor: 0
    });
    sendProviderInput = vi.fn<MaestroApi["providers"]["sendInput"]>().mockResolvedValue({ ok: true });
    workspaceStatus = vi.fn<MaestroApi["workspaces"]["status"]>().mockResolvedValue(workspaceStatusSnapshot(snapshot));
    listChangedFiles = vi.fn<MaestroApi["review"]["listChangedFiles"]>().mockResolvedValue([]);
    loadDiff = vi.fn<MaestroApi["review"]["loadDiff"]>().mockResolvedValue({
      workspaceId: "workspace-1",
      filePath: null,
      content: ""
    });
    skillsList = vi.fn<MaestroApi["skills"]["list"]>().mockResolvedValue([]);

    window.maestro = {
      dashboard: {
        load: dashboardLoad,
        list: dashboardList,
        onDelta: (listener) => {
          dashboardDeltaListener = listener;
          return dashboardDeltaUnsubscribe;
        }
      },
      projects: {
        list: () => Promise.resolve(snapshot.projects),
        pickFolder: pickProjectFolder,
        register: () => Promise.resolve(primaryProject()),
        updateSettings: () => Promise.resolve(primaryProject())
      },
      workspaces: {
        createIsolated: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        createCurrent: createCurrentWorkspace,
        refreshStatus: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        status: workspaceStatus,
        keep: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        archive: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace())
      },
      providers: {
        discover: () => Promise.resolve([]),
        launch: launchProvider,
        sendInput: sendProviderInput,
        resize: () => Promise.resolve({ ok: true }),
        terminate: () => Promise.resolve({ ok: true })
      },
      approvals: {
        pending: approvalsPending,
        resolve: () => Promise.resolve(missingApproval())
      },
      session: {
        eventsSince: sessionEventsSince
      },
      review: {
        listChangedFiles,
        loadDiff
      },
      checks: {
        run: () => Promise.resolve(missingCheck())
      },
      checkpoints: {
        create: () => Promise.resolve(missingCheckpoint())
      },
      attempts: {
        selectPreferred: () => Promise.resolve(snapshot.sessions[0] ?? missingSession())
      },
      commits: {
        prepare: () =>
          Promise.resolve({
            workspaceId: "workspace-1",
            branch: "maestro/dashboard",
            selectedFiles: ["src/renderer/App.tsx"],
            message: "feat: test",
            commands: ["git add -- 'src/renderer/App.tsx'", "git commit -m 'feat: test'"]
          })
      },
      health: {
        ping: () => Promise.resolve({ ok: true, timestamp: "2026-05-08T15:54:00.000Z" })
      },
      skills: {
        list: skillsList
      },
      system: {
        openPath: () => Promise.resolve({ ok: true })
      }
    };
  });

  it("opens the settings page from the sidebar and lets the user close it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Defaults" })).toBeInTheDocument();
    // The launcher prompt is hidden while the settings panel is showing.
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("renders the local project launcher from IPC data", async () => {
    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maestro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByLabelText("Launch model")).toHaveValue("codex:gpt-5.3-codex-spark:medium");
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
    const hideProjectSessions = screen.getByRole("button", { name: "Hide Maestro sessions" });
    fireEvent.click(hideProjectSessions);

    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Maestro sessions" })).toHaveAttribute("aria-expanded", "false");

    unmount();
    render(<App />);

    expect(await screen.findByRole("button", { name: "Show Maestro sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Maestro sessions" }));
    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
  });

  it("renders streamed dashboard deltas without reloading the full dashboard", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();
    expect(dashboardLoad).toHaveBeenCalledTimes(1);

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
    expect(dashboardLoad).toHaveBeenCalledTimes(1);
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
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      events: [snapshot.events[0]!, toolCompleted, toolStarted]
    });
    sessionEventsSince.mockResolvedValue({
      events: [snapshot.events[0]!, toolCompleted, toolStarted],
      rawOutputs: [],
      eventCursor: 3,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "web_search: pizza recipe" })).toBeInTheDocument();
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
    dashboardLoad.mockResolvedValue({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("button", { name: "Read: README.md" })).toBeInTheDocument();
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
    dashboardLoad.mockResolvedValue({ ...snapshot, events: eventsBundle });
    sessionEventsSince.mockResolvedValue({
      events: eventsBundle,
      rawOutputs: [],
      eventCursor: eventsBundle.length,
      rawOutputCursor: 0
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("I'll explore the codebase.")).toBeInTheDocument();
    expect(screen.getByText("I've explored.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 tool calls/ })).toBeInTheDocument();
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
            '{"type":"thread.started","thread_id":"019e0bd0-7694-7032-85cd-f670d78ac282"}\n{"type":"turn.started"}\n{"type":"init","cwd":"/tmp/maestro","session_id":"claude-session","tools":["Task","Bash"]}\n',
          createdAt: "2026-05-08T15:54:01.000Z"
        }
      ]
    };
    dashboardLoad.mockResolvedValue(lifecycleSnapshot);
    sessionEventsSince.mockResolvedValue({
      events: [],
      rawOutputs: lifecycleSnapshot.rawOutputs,
      eventCursor: 0,
      rawOutputCursor: 1
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();
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

    expect(await screen.findByLabelText("Launch model")).toHaveValue("codex:gpt-5.3-codex-spark:medium");
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
      provider: "codex",
      prompt: "Implement PTY launch",
      modelLabel: "Codex Spark",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "medium",
      cols: 120,
      rows: 32
    });
    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();
  });

  it("keeps a newly launched chat selected while the dashboard refresh catches up", async () => {
    const newWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-new",
      projectId: "project-1",
      taskLabel: "New chat",
      branch: "main",
      baseRef: "main",
      path: "/tmp/maestro",
      state: "running",
      sharedWorkspace: true,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:10:00.000Z"
    };
    const newSession: DashboardSnapshot["sessions"][number] = {
      id: "session-new",
      workspaceId: "workspace-new",
      provider: "codex",
      modelLabel: "GPT-5.3 Codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "medium",
      providerConversationId: null,
      prompt: "New chat",
      state: "running",
      attention: "normal",
      startedAt: "2026-05-08T16:10:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-05-08T16:10:00.000Z",
      preferred: false
    };
    const newEvent: DashboardSnapshot["events"][number] = {
      id: "event-new",
      sessionId: "session-new",
      type: "message.completed",
      message: "New chat answer.",
      payload: {},
      createdAt: "2026-05-08T16:10:01.000Z"
    };
    dashboardLoad.mockResolvedValue(snapshot);
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
    expect(screen.getByRole("button", { name: "New chat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("starts Claude when selected in the composer", async () => {
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Launch model"), {
      target: { value: "claude:claude-sonnet-4-6" }
    });
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
        cols: 120,
        rows: 32
      })
    );
  });

  it("adds a second project, selects it, and launches from that project", async () => {
    const dotfilesProject = secondProject();
    const twoProjectSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [...snapshot.projects, dotfilesProject]
    };
    pickProjectFolder.mockResolvedValue({ cancelled: false, project: dotfilesProject });
    dashboardLoad.mockResolvedValueOnce(snapshot).mockResolvedValue(twoProjectSnapshot);

    render(<App />);

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
    expect(dashboardLoad).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("shows a clear error when folder registration fails", async () => {
    pickProjectFolder.mockRejectedValue(new Error("Maestro requires a local git repository."));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Maestro requires a local git repository.");
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("offers Add Project before any projects are registered", async () => {
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      projects: [],
      workspaces: [],
      sessions: [],
      events: []
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Add a project to start" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add Project" })).toHaveLength(2);
    expect(screen.queryByTitle("Start agent")).not.toBeInTheDocument();
  });

  it("opens a sidebar session", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Second chat",
      branch: "maestro/second-chat",
      baseRef: "main",
      path: "/tmp/worktrees/second-chat",
      state: "complete",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0,
      lastActivityAt: "2026-05-08T16:04:00.000Z"
    };
    const secondSession: DashboardSnapshot["sessions"][number] = {
      id: "session-2",
      workspaceId: "workspace-2",
      provider: "claude",
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      providerConversationId: "session-2",
      prompt: "Second chat",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
    };
    const secondEvent: DashboardSnapshot["events"][number] = {
      id: "event-2",
      sessionId: "session-2",
      type: "message.completed",
      message: "Second answer.",
      payload: {},
      createdAt: "2026-05-08T16:04:00.000Z"
    };
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });
    sessionEventsSince.mockImplementation((input) => {
      if (input.sessionId === "session-2") {
        return Promise.resolve({ events: [secondEvent], rawOutputs: [], eventCursor: 2, rawOutputCursor: 0 });
      }
      return Promise.resolve({ events: snapshot.events, rawOutputs: [], eventCursor: 1, rawOutputCursor: 0 });
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Second chat" }));

    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Session model")).toHaveValue("claude-sonnet-4-6");
    expect(screen.queryByText("review-ready")).not.toBeInTheDocument();
    expect(screen.queryByText("complete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("shows a thinking indicator while a session is running", async () => {
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      events: []
    });
    sessionEventsSince.mockResolvedValue({
      events: [],
      rawOutputs: [],
      eventCursor: 0,
      rawOutputCursor: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("command-stream")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Waiting for agent")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Send a follow-up")).not.toBeInTheDocument();
  });

  it("does not show a thinking indicator after assistant output is visible", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("Dashboard ready.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    expect(screen.queryByTestId("command-stream")).not.toBeInTheDocument();
  });

  it("shows a thinking indicator for a follow-up turn after earlier assistant output", async () => {
    const followUpEvent: DashboardSnapshot["events"][number] = {
      id: "event-follow-up",
      sessionId: "session-1",
      type: "user.message",
      message: "very good!",
      payload: { source: "composer" },
      createdAt: "2026-05-08T15:55:00.000Z"
    };
    const oldRawOutput: DashboardSnapshot["rawOutputs"][number] = {
      id: "raw-old",
      sessionId: "session-1",
      stream: "stdout",
      content: "old output\n",
      createdAt: "2026-05-08T15:54:30.000Z"
    };
    const rawOutputAfterFollowUp: DashboardSnapshot["rawOutputs"][number] = {
      id: "raw-after-follow-up",
      sessionId: "session-1",
      stream: "stdout",
      content: '{"type":"turn.started"}\n',
      createdAt: "2026-05-08T15:55:01.000Z"
    };
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      rawOutputs: [oldRawOutput, rawOutputAfterFollowUp],
      events: [...snapshot.events, followUpEvent]
    });
    sessionEventsSince.mockResolvedValue({
      events: [...snapshot.events, followUpEvent],
      rawOutputs: [oldRawOutput, rawOutputAfterFollowUp],
      eventCursor: 2,
      rawOutputCursor: 2
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("Dashboard ready.")).toBeInTheDocument();
    expect(screen.getByText("very good!")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("command-stream")).toBeInTheDocument();
  });

  it("sends follow-up prompts to the selected live session", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      sessions: completeSessions
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();
    const input = await screen.findByLabelText("Session prompt");
    fireEvent.change(input, {
      target: { value: "continue with tests" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "continue with tests\r",
        modelLabel: "GPT-5.3 Codex",
        modelId: "gpt-5.3-codex",
        reasoningEffort: "medium"
      })
    );
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(launchProvider).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("switches the session model for the next follow-up prompt", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    dashboardLoad.mockResolvedValue({
      ...snapshot,
      sessions: completeSessions
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.change(await screen.findByLabelText("Session model"), {
      target: { value: "gpt-5.5:medium" }
    });
    fireEvent.change(await screen.findByLabelText("Session prompt"), {
      target: { value: "use the stronger model" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "use the stronger model\r",
        modelLabel: "GPT-5.5",
        modelId: "gpt-5.5",
        reasoningEffort: "medium"
      })
    );
  });

  it("opens a changed file review panel with parsed diff lines", async () => {
    listChangedFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx", status: "M", additions: 2, deletions: 2 },
      { path: "src/renderer/styles.css", status: "M", additions: 0, deletions: 15 }
    ]);
    loadDiff.mockResolvedValue({
      workspaceId: "workspace-1",
      filePath: "src/renderer/App.tsx",
      content: [
        "diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx",
        "--- a/src/renderer/App.tsx",
        "+++ b/src/renderer/App.tsx",
        "@@ -1,3 +1,3 @@",
        " const before = true;",
        "-const oldValue = true;",
        "+const newValue = true;",
        " const after = true;",
        "@@ -20,2 +20,2 @@",
        "-const stale = true;",
        "+const fresh = true;"
      ].join("\n")
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("2 files changed")).toBeInTheDocument();
    expect(screen.getByLabelText("2 additions, 17 deletions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide diff" }));
    expect(screen.queryByRole("button", { name: /src\/renderer\/App\.tsx/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    fireEvent.click(screen.getByRole("button", { name: /src\/renderer\/App\.tsx/ }));

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(loadDiff).toHaveBeenCalledWith("workspace-1", "src/renderer/App.tsx");
    expect(await screen.findByText("16 unmodified lines")).toBeInTheDocument();
    expect(screen.getByText("const oldValue = true;")).toBeInTheDocument();
    expect(screen.getByText("const newValue = true;")).toBeInTheDocument();
  });

  it("opens slash autocomplete in the launcher composer without a workspace id", async () => {
    skillsList.mockResolvedValue([
      { name: "plan", description: "Phased plan", source: "user" },
      { name: "impl", description: "Implement code", source: "user" }
    ]);

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Launch model"), {
      target: { value: "claude:claude-sonnet-4-6" }
    });
    const input = await screen.findByLabelText<HTMLInputElement>("Task prompt");
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByRole("listbox", { name: "Skill suggestions" })).toBeInTheDocument();
    expect(skillsList).toHaveBeenCalledWith({ provider: "claude" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/plan ");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("opens a slash autocomplete with provider-filtered skills and inserts the selected name", async () => {
    skillsList.mockImplementation(({ provider, workspaceId }) => {
      expect(workspaceId).toBe("workspace-1");
      if (provider === "codex") {
        return Promise.resolve([
          { name: "opsx-apply", description: "Apply a change", source: "codex-prompt" },
          { name: "opsx-archive", description: "Archive a change", source: "codex-prompt" }
        ]);
      }
      return Promise.resolve([
        { name: "impl", description: "Implement code from a plan", source: "user" }
      ]);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText<HTMLInputElement>("Session prompt");
    fireEvent.change(input, { target: { value: "/o" } });

    const listbox = await screen.findByRole("listbox", { name: "Skill suggestions" });
    expect(listbox).toBeInTheDocument();
    expect(skillsList).toHaveBeenCalledWith({ provider: "codex", workspaceId: "workspace-1" });

    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "/opsx-applyApply a change",
      "/opsx-archiveArchive a change"
    ]);
    // Claude-only skill must not be present in a Codex session.
    expect(screen.queryByText("/impl")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("/opsx-archive ");
    expect(sendProviderInput).not.toHaveBeenCalled();
  });

  it("submits the composer on Enter without reloading the page", async () => {
    render(<App />);

    const input = await screen.findByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "Implement PTY launch" } });

    const form = input.closest("form");
    if (!form) {
      throw new Error("Composer form not found");
    }

    // Dispatch a real submit event so we can read defaultPrevented after the
    // React onSubmit handler runs (a target-phase listener would observe the
    // pre-React state).
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    act(() => {
      form.dispatchEvent(submitEvent);
    });

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Implement PTY launch", provider: "codex" })
    );
    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it("returns to the composer from an open session via the project row", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Maestro" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Maestro" }));

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("discards a stale dashboard load when a newer load completes first", async () => {
    let resolveSlow: ((data: DashboardSnapshot) => void) | null = null;
    const slowSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Stale-Project"
        }
      ]
    };
    const fastSnapshot: DashboardSnapshot = {
      ...snapshot,
      projects: [
        {
          ...primaryProject(),
          name: "Fresh-Project"
        }
      ]
    };

    let callCount = 0;
    dashboardLoad.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<DashboardSnapshot>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(fastSnapshot);
    });

    render(<App />);

    // Wait for the first invocation to be in flight.
    await waitFor(() => expect(callCount).toBe(1));

    act(() => {
      dashboardDeltaListener?.({ projects: fastSnapshot.projects });
    });

    // Now resolve the first (slow) load with stale data.
    (resolveSlow as ((data: DashboardSnapshot) => void) | null)?.(slowSnapshot);

    // Snapshot should reflect the second (fast) load result, not the stale first.
    expect(await screen.findByRole("button", { name: "Fresh-Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stale-Project" })).not.toBeInTheDocument();
  });

  it("renders the dashboard error state with a Retry button and reloads on click", async () => {
    let attempts = 0;
    dashboardLoad.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("backend-fault"));
      }
      return Promise.resolve(snapshot);
    });

    render(<App />);

    expect(await screen.findByText(/backend-fault/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });
});

describe("App without preload bridge", () => {
  it("renders the bridge-missing banner when window.maestro is undefined", async () => {
    const previousMaestro = window.maestro;
    delete (window as { maestro?: MaestroApi }).maestro;

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
      window.maestro = previousMaestro;
    }
  });
});

function primaryProject() {
  const project = snapshot.projects[0];
  if (!project) {
    throw new Error("Test snapshot must include a project");
  }
  return project;
}

function secondProject(): DashboardSnapshot["projects"][number] {
  return {
    id: "project-2",
    name: "Dotfiles",
    repoPath: "/tmp/dotfiles",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.3 Codex",
      worktreeLocation: "/tmp/dotfiles-worktrees",
      setupCommand: "",
      checkCommands: []
    },
    counts: {
      active: 0,
      blocked: 0,
      failed: 0,
      reviewReady: 0
    },
    latestActivityAt: "2026-05-08T16:30:00.000Z"
  };
}

function missingWorkspace(): never {
  throw new Error("Test snapshot must include a workspace");
}

function missingSession(): never {
  throw new Error("Test snapshot must include a session");
}

function missingApproval(): never {
  throw new Error("Test snapshot must include an approval");
}

function missingCheck(): never {
  throw new Error("Test snapshot must include a check");
}

function missingCheckpoint(): never {
  throw new Error("Test snapshot must include a checkpoint");
}
