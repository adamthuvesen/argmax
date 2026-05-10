import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        defaultModelLabel: "GPT-5.3 Codex Spark Low",
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
      modelLabel: "GPT-5.3 Codex Spark Low",
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
  let sessionEventsSince: ReturnType<typeof vi.fn<MaestroApi["session"]["eventsSince"]>>;
  let sendProviderInput: ReturnType<typeof vi.fn<MaestroApi["providers"]["sendInput"]>>;
  let workspaceStatus: ReturnType<typeof vi.fn<MaestroApi["workspaces"]["status"]>>;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
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
        listChangedFiles: () => Promise.resolve([]),
        loadDiff: () => Promise.resolve({ workspaceId: "workspace-1", filePath: null, content: "" })
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
      }
    };
  });

  it("renders the local project launcher from IPC data", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maestro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cockpit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("renders streamed dashboard deltas without reloading the full dashboard", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByText(/thread\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/turn\.started/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"tools"/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("unsubscribes from dashboard deltas on unmount", async () => {
    const rendered = render(<App />);

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
    rendered.unmount();

    expect(dashboardDeltaUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not schedule focused dashboard polling while work is active", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    try {
      render(<App />);

      expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1200);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("starts the default provider from the composer", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
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
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      cols: 120,
      rows: 32
    });
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
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
      modelLabel: "GPT-5.3 Codex Spark Low",
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

    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Review this change" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        provider: "claude",
        prompt: "Review this change",
        modelLabel: "Claude Haiku",
        modelId: "haiku",
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
    expect(await screen.findByRole("heading", { name: "What should we build in dotfiles?" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalledTimes(1));
    expect(dashboardLoad).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
  });

  it("shows a clear error when folder registration fails", async () => {
    pickProjectFolder.mockRejectedValue(new Error("Maestro requires a local git repository."));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Maestro requires a local git repository.");
    expect(screen.getByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
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
      modelLabel: "Claude Haiku",
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

    expect(await screen.findByRole("heading", { name: "Second chat" })).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
    expect(screen.getByText("Claude Haiku")).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Session prompt"), {
      target: { value: "continue with tests" }
    });
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith({
        sessionId: "session-1",
        input: "continue with tests\r"
      })
    );
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
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Maestro" }));

    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "What should we build in maestro?" })).toBeInTheDocument();
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
      defaultModelLabel: "GPT-5.3 Codex Spark Low",
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
