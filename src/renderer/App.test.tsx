import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { DashboardDelta, DashboardSnapshot, ArgmaxApi } from "../shared/types.js";
import { WORKSPACE_DRAG_MIME } from "./lib/gridState.js";

const snapshot: DashboardSnapshot = {
  projects: [
    {
      id: "project-1",
      name: "Argmax",
      repoPath: "/tmp/argmax",
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
      branch: "argmax/dashboard",
      baseRef: "main",
      path: "/tmp/worktrees/dashboard",
      state: "running",
      sharedWorkspace: false,
      dirty: true,
      changedFiles: 3,
      lastActivityAt: "2026-05-08T15:54:00.000Z",
      pinned: false
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
      permissionMode: "auto-approve",
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

function dashboardListSnapshot(data: DashboardSnapshot): Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>> {
  return {
    projects: data.projects,
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

function workspaceStatusSnapshot(data: DashboardSnapshot): Awaited<ReturnType<ArgmaxApi["workspaces"]["status"]>> {
  return {
    workspaces: data.workspaces,
    sessions: data.sessions,
    checks: data.checks,
    checkpoints: data.checkpoints
  };
}

describe("App", () => {
  let createCurrentWorkspace: ReturnType<typeof vi.fn<ArgmaxApi["workspaces"]["createCurrent"]>>;
  let dashboardLoad: ReturnType<typeof vi.fn<ArgmaxApi["dashboard"]["load"]>>;
  let dashboardList: ReturnType<typeof vi.fn<ArgmaxApi["dashboard"]["list"]>>;
  let dashboardDeltaListener: ((delta: DashboardDelta) => void) | null;
  let dashboardDeltaUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
  let launchProvider: ReturnType<typeof vi.fn<ArgmaxApi["providers"]["launch"]>>;
  let approvalsPending: ReturnType<typeof vi.fn<ArgmaxApi["approvals"]["pending"]>>;
  let approvalsResolve: ReturnType<typeof vi.fn<ArgmaxApi["approvals"]["resolve"]>>;
  let pickProjectFolder: ReturnType<typeof vi.fn<ArgmaxApi["projects"]["pickFolder"]>>;
  let listChangedFiles: ReturnType<typeof vi.fn<ArgmaxApi["review"]["listChangedFiles"]>>;
  let loadDiff: ReturnType<typeof vi.fn<ArgmaxApi["review"]["loadDiff"]>>;
  let listChangedFilesForProject: ReturnType<typeof vi.fn<ArgmaxApi["review"]["listChangedFilesForProject"]>>;
  let loadDiffForProject: ReturnType<typeof vi.fn<ArgmaxApi["review"]["loadDiffForProject"]>>;
  let listWorkspaceFiles: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFiles"]>>;
  let readWorkspaceFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["readFile"]>>;
  let listProjectFiles: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFilesForProject"]>>;
  let readProjectFile: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["readFileForProject"]>>;
  let sessionEventsSince: ReturnType<typeof vi.fn<ArgmaxApi["session"]["eventsSince"]>>;
  let sessionCostSummary: ReturnType<typeof vi.fn<ArgmaxApi["session"]["costSummary"]>>;
  let sendProviderInput: ReturnType<typeof vi.fn<ArgmaxApi["providers"]["sendInput"]>>;
  let terminateProvider: ReturnType<typeof vi.fn<ArgmaxApi["providers"]["terminate"]>>;
  let providersDiscover: ReturnType<typeof vi.fn<ArgmaxApi["providers"]["discover"]>>;
  let diagnosticsStub: ReturnType<typeof vi.fn<ArgmaxApi["system"]["diagnostics"]>>;
  let vacuumDatabaseStub: ReturnType<typeof vi.fn<ArgmaxApi["system"]["vacuumDatabase"]>>;
  let createCheckpointStub: ReturnType<typeof vi.fn<ArgmaxApi["checkpoints"]["create"]>>;
  let workspaceStatus: ReturnType<typeof vi.fn<ArgmaxApi["workspaces"]["status"]>>;
  let skillsList: ReturnType<typeof vi.fn<ArgmaxApi["skills"]["list"]>>;
  let openInIde: ReturnType<typeof vi.fn<ArgmaxApi["workspaces"]["openInIde"]>>;
  let listDetectedIdes: ReturnType<typeof vi.fn<ArgmaxApi["system"]["listDetectedIdes"]>>;
  let menuCommandListener: ((command: Parameters<Parameters<ArgmaxApi["menu"]["onCommand"]>[0]>[0]) => void) | null;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.localStorage.clear();
    // Pre-seed the boot-collapse marker so existing App tests render the
    // sidebar with projects expanded (the pre-fix behavior). Sidebar tests
    // that exercise the boot-collapse seed clear this marker themselves.
    window.sessionStorage.setItem("argmax.sidebar.bootCollapseSeeded", "1");
    createCurrentWorkspace = vi.fn<ArgmaxApi["workspaces"]["createCurrent"]>().mockResolvedValue(
      snapshot.workspaces[0] ?? missingWorkspace()
    );
    dashboardLoad = vi.fn<ArgmaxApi["dashboard"]["load"]>().mockResolvedValue(snapshot);
    dashboardList = vi.fn<ArgmaxApi["dashboard"]["list"]>().mockResolvedValue(dashboardListSnapshot(snapshot));
    dashboardDeltaListener = null;
    dashboardDeltaUnsubscribe = vi.fn<() => void>();
    launchProvider = vi.fn<ArgmaxApi["providers"]["launch"]>().mockResolvedValue(snapshot.sessions[0] ?? missingSession());
    approvalsPending = vi.fn<ArgmaxApi["approvals"]["pending"]>().mockResolvedValue(snapshot.approvals);
    approvalsResolve = vi.fn<ArgmaxApi["approvals"]["resolve"]>().mockImplementation(({ approvalId, status }) =>
      Promise.resolve({
        id: approvalId,
        sessionId: "session-1",
        command: "rm -rf /tmp/x",
        cwd: "/tmp",
        provider: "codex",
        riskLevel: "high",
        status,
        createdAt: "2026-05-14T10:00:00.000Z",
        resolvedAt: new Date().toISOString()
      })
    );
    pickProjectFolder = vi.fn<ArgmaxApi["projects"]["pickFolder"]>().mockResolvedValue({
      cancelled: false,
      project: primaryProject()
    });
    sessionEventsSince = vi.fn<ArgmaxApi["session"]["eventsSince"]>().mockResolvedValue({
      events: snapshot.events,
      rawOutputs: snapshot.rawOutputs,
      eventCursor: 0,
      rawOutputCursor: 0
    });
    sessionCostSummary = vi.fn<ArgmaxApi["session"]["costSummary"]>().mockResolvedValue({
      sessionId: "session-1",
      modelId: "gpt-5.3-codex",
      tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 },
      costUsd: 0.012
    });
    sendProviderInput = vi.fn<ArgmaxApi["providers"]["sendInput"]>().mockResolvedValue({ ok: true, queued: false });
    terminateProvider = vi.fn<ArgmaxApi["providers"]["terminate"]>().mockResolvedValue({ ok: true });
    providersDiscover = vi.fn<ArgmaxApi["providers"]["discover"]>().mockResolvedValue([]);
    diagnosticsStub = vi.fn<ArgmaxApi["system"]["diagnostics"]>().mockResolvedValue({
      appVersion: "0.1.0",
      electronVersion: "35.0.0",
      nodeVersion: "20.0.0",
      sqliteVersion: "3.45.0",
      databasePath: "/tmp/argmax.sqlite",
      platform: "darwin",
      arch: "arm64",
      generatedAt: "2026-05-12T00:00:00.000Z",
      startupPhases: [
        { phase: "boot", elapsedMs: 0, deltaMs: 0 },
        { phase: "db.open", elapsedMs: 80, deltaMs: 80 },
        { phase: "services.construct", elapsedMs: 140, deltaMs: 60 },
        { phase: "ipc.register", elapsedMs: 180, deltaMs: 40 },
        { phase: "window.create", elapsedMs: 400, deltaMs: 220 },
        { phase: "window.ready-to-show", elapsedMs: 1100, deltaMs: 700 }
      ],
      databaseStats: {
        rowCounts: {
          projects: 1,
          workspaces: 2,
          sessions: 4,
          events: 120,
          rawOutputs: 60,
          approvals: 0,
          checks: 3,
          checkpoints: 1,
          learnings: 5,
          usageEvents: 18
        },
        walBytes: 1024 * 128,
        walAutocheckpoint: 1000
      },
      ipcStats: [
        { channel: "dashboard:list", count: 12, totalRecorded: 12, p50: 1.2, p99: 4.8 },
        { channel: "providers:launch", count: 3, totalRecorded: 3, p50: 18.5, p99: 32.1 }
      ],
      recentLogs: [
        {
          timestamp: "2026-05-14T11:00:00.000Z",
          level: "info",
          scope: "providers.session",
          message: "session launched",
          fields: { sessionId: "session-1" }
        },
        {
          timestamp: "2026-05-14T11:00:05.000Z",
          level: "warn",
          scope: "gh.poller",
          message: "ghService.refresh failed",
          fields: {}
        }
      ]
    });
    vacuumDatabaseStub = vi.fn<ArgmaxApi["system"]["vacuumDatabase"]>().mockResolvedValue({ ok: true });
    createCheckpointStub = vi.fn<ArgmaxApi["checkpoints"]["create"]>().mockResolvedValue({
      id: "checkpoint-1",
      workspaceId: "workspace-1",
      label: "Checkpoint",
      branch: "argmax/dashboard",
      gitRef: null,
      patchPath: null,
      createdAt: "2026-05-12T00:00:00.000Z"
    });
    menuCommandListener = null;
    workspaceStatus = vi.fn<ArgmaxApi["workspaces"]["status"]>().mockResolvedValue(workspaceStatusSnapshot(snapshot));
    listChangedFiles = vi.fn<ArgmaxApi["review"]["listChangedFiles"]>().mockResolvedValue([]);
    loadDiff = vi.fn<ArgmaxApi["review"]["loadDiff"]>().mockResolvedValue({
      workspaceId: "workspace-1",
      filePath: null,
      content: ""
    });
    listChangedFilesForProject = vi.fn<ArgmaxApi["review"]["listChangedFilesForProject"]>().mockResolvedValue([]);
    loadDiffForProject = vi.fn<ArgmaxApi["review"]["loadDiffForProject"]>().mockResolvedValue({
      workspaceId: "",
      filePath: null,
      content: ""
    });
    listWorkspaceFiles = vi.fn<ArgmaxApi["workspace"]["listFiles"]>().mockResolvedValue([]);
    readWorkspaceFile = vi.fn<ArgmaxApi["workspace"]["readFile"]>().mockResolvedValue({
      kind: "text",
      content: "",
      size: 0,
      mtimeMs: 0
    });
    listProjectFiles = vi.fn<ArgmaxApi["workspace"]["listFilesForProject"]>().mockResolvedValue([]);
    readProjectFile = vi.fn<ArgmaxApi["workspace"]["readFileForProject"]>().mockResolvedValue({
      kind: "skipped",
      reason: "not-a-file"
    } as const);
    skillsList = vi.fn<ArgmaxApi["skills"]["list"]>().mockResolvedValue([]);
    openInIde = vi.fn<ArgmaxApi["workspaces"]["openInIde"]>().mockResolvedValue({ ok: true });
    listDetectedIdes = vi.fn<ArgmaxApi["system"]["listDetectedIdes"]>().mockResolvedValue([
      { id: "vscode", label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true },
      { id: "cursor", label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true },
      { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
    ]);

    window.argmax = {
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
        remove: ({ projectId }) => Promise.resolve({ projectId }),
        updateSettings: () => Promise.resolve(primaryProject()),
        listBranches: () => Promise.resolve(["main"]),
        switchBranch: () => Promise.resolve(primaryProject())
      },
      workspaces: {
        createIsolated: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        createCurrent: createCurrentWorkspace,
        refreshStatus: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        status: workspaceStatus,
        keep: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        archive: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
        openInIde: openInIde,
        setPinned: ({ workspaceId, pinned }) =>
          Promise.resolve({
            ...(snapshot.workspaces[0] ?? missingWorkspace()),
            id: workspaceId,
            pinned
          })
      },
      providers: {
        discover: providersDiscover,
        launch: launchProvider,
        sendInput: sendProviderInput,
        resize: () => Promise.resolve({ ok: true }),
        terminate: terminateProvider,
        cancelQueuedMessage: () => Promise.resolve({ ok: true })
      },
      attachments: {
        saveImage: () => Promise.resolve({ filePath: "/tmp/fake.png", sizeBytes: 0 })
      },
      approvals: {
        pending: approvalsPending,
        resolve: approvalsResolve
      },
      session: {
        eventsSince: sessionEventsSince,
        costSummary: sessionCostSummary,
        search: () => Promise.resolve([])
      },
      review: {
        listChangedFiles,
        loadDiff,
        listChangedFilesForProject,
        loadDiffForProject
      },
      workspace: {
        listFiles: listWorkspaceFiles,
        readFile: readWorkspaceFile,
        writeFile: () => Promise.resolve({ ok: true, mtimeMs: 0, size: 0 } as const),
        statFile: () => Promise.resolve({ mtimeMs: 0, size: 0 }),
        listFilesForProject: listProjectFiles,
        readFileForProject: readProjectFile,
        writeFileForProject: () => Promise.resolve({ ok: true, mtimeMs: 0, size: 0 } as const),
        statFileForProject: () => Promise.resolve({ mtimeMs: 0, size: 0 }),
        grepContent: () => Promise.resolve({ files: [], truncated: false })
      },
      checks: {
        run: () => Promise.resolve(missingCheck())
      },
      checkpoints: {
        create: createCheckpointStub
      },
      attempts: {
        selectPreferred: () => Promise.resolve(snapshot.sessions[0] ?? missingSession())
      },
      health: {
        ping: () => Promise.resolve({ ok: true, timestamp: "2026-05-08T15:54:00.000Z" })
      },
      skills: {
        list: skillsList
      },
      system: {
        openPath: () => Promise.resolve({ ok: true }),
        listDetectedIdes: listDetectedIdes,
        diagnostics: diagnosticsStub,
        vacuumDatabase: vacuumDatabaseStub
      },
      mcp: {
        list: () => Promise.resolve([]),
        auth: {
          start: () => Promise.resolve({ sessionId: "test-mcp-auth" }),
          write: () => Promise.resolve({ ok: true }),
          resize: () => Promise.resolve({ ok: true }),
          terminate: () => Promise.resolve({ ok: true }),
          onData: () => () => undefined,
          onExit: () => () => undefined
        }
      },
      menu: {
        onCommand: (listener) => {
          menuCommandListener = listener;
          return () => {
            menuCommandListener = null;
          };
        }
      },
      learnings: {
        list: () => Promise.resolve([]),
        update: (input) =>
          Promise.resolve({
            id: input.id,
            projectId: "project-1",
            kind: "pitfall",
            summary: input.summary ?? "",
            evidenceSessionId: null,
            evidenceEventId: null,
            verified: input.verified ?? false,
            hits: 0,
            createdAt: "2026-05-12T00:00:00.000Z",
            lastSeenAt: "2026-05-12T00:00:00.000Z"
          }),
        delete: () => Promise.resolve({ ok: true })
      },
      prs: {
        listForSession: () => Promise.resolve([]),
        refresh: () => Promise.resolve([])
      },
      git: {
        commit: () => Promise.resolve({ commitSha: "deadbeef", branch: "main" }),
        push: () => Promise.resolve({ branch: "main", upstreamSet: false }),
        createBranch: () => Promise.resolve({ branch: "feature/x" }),
        viewOrCreatePr: () => Promise.resolve({ action: "opened", url: "https://x", prNumber: 1 })
      },
      terminal: {
        spawn: () => Promise.resolve({ terminalId: "test-terminal" }),
        write: () => Promise.resolve({ ok: true }),
        resize: () => Promise.resolve({ ok: true }),
        terminate: () => Promise.resolve({ ok: true }),
        onData: () => () => undefined,
        onExit: () => () => undefined
      },
      tournaments: {
        launch: () => Promise.reject(new Error("not mocked")),
        list: () => Promise.resolve([]),
        get: () => Promise.reject(new Error("not mocked")),
        keep: () => Promise.reject(new Error("not mocked"))
      },
      scoring: {
        listPolicies: () => Promise.resolve([])
      }
    };
  });

  function mockDashboardSnapshot(data: DashboardSnapshot): void {
    dashboardLoad.mockResolvedValue(data);
    dashboardList.mockResolvedValue(dashboardListSnapshot(data));
    approvalsPending.mockResolvedValue(data.approvals);
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(data));
  }

  async function openSettings(group: "General" | "Agents" | "Integrations" | "System" = "General"): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    if (group === "General") return;

    const settingsGroups = screen.getByRole("complementary", { name: "Settings groups" });
    fireEvent.click(within(settingsGroups).getByRole("button", { name: new RegExp(`\\b${group}\\b`) }));
  }

  it("opens the settings page from the sidebar and lets the user close it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local profile" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch defaults" })).toBeInTheDocument();
    // The launcher prompt is hidden while the settings panel is showing.
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("settings Default model label is wired to the select via htmlFor/id", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Model defaults" });

    // getByLabelText only resolves the SELECT element when label.htmlFor
    // matches the select's id — i.e. the wiring is correct end-to-end.
    const select = screen.getByLabelText("Default model");
    expect(select.tagName).toBe("SELECT");
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
      agentMode: "auto",
      permissionMode: "auto-approve",
      cols: 120,
      rows: 32
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
    expect(window.localStorage.getItem("argmax.launch.agentMode")).toBe("plan");
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
    expect(screen.getByRole("button", { name: "New chat" })).toHaveAttribute("aria-pressed", "true");
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
      preferred: false
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
    fireEvent.click(screen.getByRole("button", { name: "Claude Sonnet 4.6" }));
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
        agentMode: "auto",
        permissionMode: "auto-approve",
        cols: 120,
        rows: 32
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

  it("opens a sidebar session", async () => {
    const secondWorkspace: DashboardSnapshot["workspaces"][number] = {
      id: "workspace-2",
      projectId: "project-1",
      taskLabel: "Second chat",
      branch: "argmax/second-chat",
      baseRef: "main",
      path: "/tmp/worktrees/second-chat",
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
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
    mockDashboardSnapshot({
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

    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Session model" })).toHaveTextContent("Claude Sonnet 4.6");
    expect(screen.queryByText("review-ready")).not.toBeInTheDocument();
    expect(screen.queryByText("complete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("shows a thinking indicator while a session is running", async () => {
    mockDashboardSnapshot({
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

  it("keeps the thinking indicator after assistant output when the session is still running", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    expect(await screen.findByText("Dashboard ready.")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("command-stream")).toBeInTheDocument();
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
    mockDashboardSnapshot({
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
    const completeSnapshot = {
      ...snapshot,
      sessions: completeSessions
    };
    mockDashboardSnapshot({
      ...snapshot,
      sessions: completeSessions
    });
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
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
        reasoningEffort: "medium",
        agentMode: "auto"
      })
    );
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(launchProvider).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("appends @path references when files are dropped onto the composer", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    const completeSnapshot = { ...snapshot, sessions: completeSessions };
    mockDashboardSnapshot(completeSnapshot);
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Session prompt");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    // Synthesize an Electron-shaped drop: File objects with a `path` field.
    const insideWorkspace = new File([], "app.ts");
    Object.defineProperty(insideWorkspace, "path", {
      value: "/tmp/worktrees/dashboard/src/app.ts"
    });
    const outsideWorkspace = new File([], "notes.md");
    Object.defineProperty(outsideWorkspace, "path", { value: "/tmp/notes.md" });

    fireEvent.drop(form!, {
      dataTransfer: {
        files: [insideWorkspace, outsideWorkspace],
        types: ["Files"]
      }
    });

    await waitFor(() => {
      const value = (input as HTMLTextAreaElement).value;
      expect(value).toContain("@src/app.ts");
      expect(value).toContain("@/tmp/notes.md");
    });
  });

  it("keeps the composer enabled while running so follow-ups can be queued", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Session prompt");
    // Composer is enabled while running; the actual send is routed to the
    // queue in main (see providerSessionService.queue.test.ts).
    expect(input).toBeEnabled();
    // Stop is still available alongside Send while a turn is in flight.
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });

  it("saves a checkpoint via the session header button on a dirty worktree", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
    const checkpointButton = await screen.findByRole("menuitem", { name: "Save checkpoint" });
    expect(checkpointButton).toBeEnabled();
    fireEvent.click(checkpointButton);

    await waitFor(() => expect(createCheckpointStub).toHaveBeenCalledTimes(1));
    const callArg = createCheckpointStub.mock.calls[0]?.[0];
    expect(callArg?.workspaceId).toBe("workspace-1");
    expect(callArg?.label).toMatch(/^Checkpoint /);
    expect(await screen.findByText(/Saved Checkpoint /)).toBeInTheDocument();
  });

  it("surfaces a Stop button on a running session and terminates it", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const stopButton = await screen.findByRole("button", { name: "Stop session" });
    // Stop replaces the send/queue mascot in the same slot while running.
    // Follow-ups are queued via Enter in the textarea, not via a visible button.
    expect(
      screen.queryByRole("button", { name: "Queue follow-up — sent when the current turn finishes" })
    ).not.toBeInTheDocument();

    fireEvent.click(stopButton);

    await waitFor(() => expect(terminateProvider).toHaveBeenCalledWith("session-1"));
  });

  it("copies diagnostics to clipboard from Settings → Diagnostics", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    const previousClipboard = (navigator as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    try {
      render(<App />);
      await screen.findByRole("button", { name: "Build dashboard" });

      await openSettings("System");
      expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

      const copyButton = await screen.findByRole("button", { name: "Copy diagnostics" });
      await waitFor(() => expect(copyButton).toBeEnabled());
      fireEvent.click(copyButton);

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const arg = writeText.mock.calls[0]?.[0] ?? "";
      const parsed = JSON.parse(arg) as { appVersion: string };
      expect(parsed.appVersion).toBe("0.1.0");
    } finally {
      if (previousClipboard === undefined) {
        delete (navigator as { clipboard?: unknown }).clipboard;
      } else {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: previousClipboard
        });
      }
    }
  });

  it("renders Approve / Reject for a pending approval and pipes back through approvals:resolve (P8.02)", async () => {
    // Seed a pending approval in the snapshot AND in the approvalsPending mock
    // so the SessionPane picks it up after the workspace is selected.
    const pendingApproval = {
      id: "approval-1",
      sessionId: "session-1",
      command: "rm -rf /tmp/x",
      cwd: "/tmp",
      provider: "codex" as const,
      riskLevel: "high" as const,
      status: "pending" as const,
      createdAt: "2026-05-14T10:00:00.000Z",
      resolvedAt: null
    };
    const seeded = { ...snapshot, approvals: [pendingApproval] };
    dashboardList.mockResolvedValue(dashboardListSnapshot(seeded));
    approvalsPending.mockResolvedValue([pendingApproval]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));

    // The risk-gate surface lives in SessionPane once a workspace is selected.
    const approveButton = await screen.findByRole("button", { name: "Approve" });
    const rejectButton = await screen.findByRole("button", { name: "Reject" });
    expect(approveButton).toBeEnabled();
    expect(rejectButton).toBeEnabled();

    fireEvent.click(approveButton);

    await waitFor(() => expect(approvalsResolve).toHaveBeenCalledTimes(1));
    expect(approvalsResolve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      status: "approved"
    });
  });

  it("Save log file downloads a JSONL of recent logs (P8.04)", async () => {
    // jsdom doesn't implement URL.createObjectURL by default. Stub it.
    const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue("blob:argmax/fixture");
    const revokeObjectURL = vi.fn<(url: string) => void>();
    const prevCreate = (URL as unknown as { createObjectURL?: typeof createObjectURL }).createObjectURL;
    const prevRevoke = (URL as unknown as { revokeObjectURL?: typeof revokeObjectURL }).revokeObjectURL;
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    // Spy on anchor click — we don't want the test to actually navigate.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      render(<App />);
      await screen.findByRole("button", { name: "Build dashboard" });
      await openSettings("System");

      const saveButton = await screen.findByRole("button", { name: "Save log file" });
      await waitFor(() => expect(saveButton).toBeEnabled());
      fireEvent.click(saveButton);

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(blob?.type).toBe("application/jsonl");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:argmax/fixture");

      // Status confirms the save.
      expect(await screen.findByText(/Saved 2 log entries\./)).toBeInTheDocument();
    } finally {
      Object.assign(URL, { createObjectURL: prevCreate, revokeObjectURL: prevRevoke });
      clickSpy.mockRestore();
    }
  });

  it("renders Settings → Diagnostics → Recent logs (P7.01)", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("System");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    const list = await screen.findByRole("list", { name: "Recent log entries" });
    expect(within(list).getByText("session launched")).toBeInTheDocument();
    expect(within(list).getByText("ghService.refresh failed")).toBeInTheDocument();
    // The warn entry's level tag.
    expect(within(list).getByText("warn")).toBeInTheDocument();
  });

  it("renders Settings → Diagnostics → IPC latency stats (P7.02)", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("System");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "IPC channel latency" });
    expect(within(table).getByText("dashboard:list")).toBeInTheDocument();
    expect(within(table).getByText("providers:launch")).toBeInTheDocument();
    // p50 = 1.2 ms for dashboard:list per the fixture.
    expect(within(table).getByText("1.20 ms")).toBeInTheDocument();
    // p99 = 32.1 ms for providers:launch per the fixture.
    expect(within(table).getByText("32.10 ms")).toBeInTheDocument();
  });

  it("renders Settings → Diagnostics → Database row counts (P7.03)", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("System");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    const databaseHeading = await screen.findByRole("heading", { name: "Database" });
    const card = databaseHeading.closest(".settings-card") as HTMLElement;
    expect(card).toBeTruthy();
    // Default fixture: 1 project, 2 workspaces, 4 sessions, 120 events.
    expect(within(card).getByText("Projects").nextElementSibling?.textContent).toBe("1");
    expect(within(card).getByText("Workspaces").nextElementSibling?.textContent).toBe("2");
    expect(within(card).getByText("Sessions").nextElementSibling?.textContent).toBe("4");
    expect(within(card).getByText("Events").nextElementSibling?.textContent).toBe("120");
    // 128 KB WAL → renders as "128 KB" (formatBytes drops decimals at the KB boundary).
    expect(within(card).getByText("WAL size").nextElementSibling?.textContent).toBe("128 KB");
    expect(within(card).getByText("WAL autocheckpoint").nextElementSibling?.textContent).toBe(
      "1,000 pages"
    );
  });

  it("renders Settings → Diagnostics → Startup phases with an over-budget badge (P7.04)", async () => {
    // Re-stub diagnostics with an over-budget ready-to-show timing so the
    // badge appears. The default fixture is under 1500 ms.
    diagnosticsStub.mockResolvedValueOnce({
      appVersion: "0.1.0",
      electronVersion: "35.0.0",
      nodeVersion: "20.0.0",
      sqliteVersion: "3.45.0",
      databasePath: "/tmp/argmax.sqlite",
      platform: "darwin",
      arch: "arm64",
      generatedAt: "2026-05-14T00:00:00.000Z",
      startupPhases: [
        { phase: "boot", elapsedMs: 0, deltaMs: 0 },
        { phase: "db.open", elapsedMs: 80, deltaMs: 80 },
        { phase: "services.construct", elapsedMs: 140, deltaMs: 60 },
        { phase: "ipc.register", elapsedMs: 180, deltaMs: 40 },
        { phase: "window.create", elapsedMs: 400, deltaMs: 220 },
        { phase: "window.ready-to-show", elapsedMs: 1800, deltaMs: 1400 }
      ],
      databaseStats: {
        rowCounts: {
          projects: 1, workspaces: 2, sessions: 4, events: 120,
          rawOutputs: 60, approvals: 0, checks: 3, checkpoints: 1,
          learnings: 5, usageEvents: 18
        },
        walBytes: 0,
        walAutocheckpoint: 1000
      },
      ipcStats: [],
      recentLogs: []
    });

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("System");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Startup phase timings" });
    expect(table).toBeInTheDocument();
    expect(within(table).getByText("db.open")).toBeInTheDocument();
    expect(within(table).getByText("window.ready-to-show")).toBeInTheDocument();

    // Over-budget row has the badge.
    const badge = within(table).getByText("over budget");
    expect(badge).toBeInTheDocument();
    // The badge is attached to the over-budget ready-to-show row.
    const overRow = badge.closest("tr");
    expect(overRow?.getAttribute("data-over-budget")).toBe("true");

    // Ralph A3: summary tile flips to over-budget for the same fixture.
    const summary = screen.getByRole("status", { name: "Cold start budget summary" });
    expect(summary).toHaveAttribute("data-over-budget", "true");
    expect(summary).toHaveTextContent("1800 ms");
    expect(summary).toHaveTextContent("budget: 1500 ms");
  });

  it("renders the cold-start summary tile under budget for a fast boot (ralph A3)", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("System");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    // The default diagnostics fixture has window.ready-to-show at 1100 ms,
    // which is comfortably under the 1500 ms budget.
    const summary = await screen.findByRole("status", { name: "Cold start budget summary" });
    expect(summary).not.toHaveAttribute("data-over-budget");
    expect(summary).toHaveTextContent("1100 ms");
    expect(summary).toHaveTextContent("budget: 1500 ms");
    expect(within(summary).queryByText("over budget")).toBeNull();
  });

  it("renders Settings → Providers with install hint when a provider is missing", async () => {
    providersDiscover.mockResolvedValueOnce([
      {
        provider: "claude",
        displayName: "Claude Code",
        binaryName: "claude",
        installed: true,
        binaryPath: "/usr/local/bin/claude",
        version: "1.2.3",
        modes: ["structured-json"],
        setupGuidance: null
      },
      {
        provider: "codex",
        displayName: "Codex",
        binaryName: "codex",
        installed: false,
        binaryPath: null,
        version: null,
        modes: [],
        setupGuidance: "Install via npm i -g @openai/codex"
      }
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Agents");
    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();

    expect(await screen.findByText(/Installed · v1\.2\.3/)).toBeInTheDocument();
    expect(screen.getByText("Not found on PATH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Install Codex CLI" })).toHaveAttribute(
      "href",
      "https://github.com/openai/codex"
    );
  });

  it("opens the keyboard cheat sheet on Cmd+/ and closes on the X button", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    fireEvent.keyDown(document, { key: "/", metaKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Open command palette")).toBeInTheDocument();
    expect(within(dialog).getByText("Open Settings")).toBeInTheDocument();
    expect(within(dialog).getByText("Jump to session 1–9")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull()
    );
  });

  it("opens the command palette on Cmd+K and routes Enter to a matching session", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const paletteInput = await screen.findByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(paletteInput, { target: { value: "Settings" } });

    const option = await screen.findByRole("option", { name: /Open Settings/ });
    expect(option).toBeInTheDocument();

    fireEvent.keyDown(paletteInput, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("closes the command palette on Escape without dispatching a command", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const paletteInput = await screen.findByRole("searchbox", { name: "Command palette query" });

    fireEvent.keyDown(paletteInput, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("searchbox", { name: "Command palette query" })).toBeNull()
    );
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("opens Settings via Cmd+, keyboard shortcut", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    fireEvent.keyDown(document, { key: ",", metaKey: true });

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("opens Settings when the main process sends the open-settings menu command", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    expect(menuCommandListener).not.toBeNull();

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    act(() => {
      menuCommandListener?.("open-settings");
    });

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("does not trigger Cmd shortcuts while typing in the composer", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Session prompt");

    fireEvent.keyDown(input, { key: ",", metaKey: true });
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("closes the Settings panel on Escape", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull()
    );
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

  it("does not close Settings on Escape when focus is in a textarea", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    textarea.remove();
  });

  it("switches the session model for the next follow-up prompt", async () => {
    const completeSessions = snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }));
    mockDashboardSnapshot({
      ...snapshot,
      sessions: completeSessions
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Session model" }));
    const modelPopover = await screen.findByRole("listbox", { name: "Session model" });
    fireEvent.click(within(modelPopover).getByRole("button", { name: "GPT-5.5 · Medium" }));
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
        reasoningEffort: "medium",
        agentMode: "auto"
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
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open changed files in review panel" }));

    const reviewPanel = await screen.findByRole("complementary", { name: "Review panel" });
    expect(reviewPanel).toBeInTheDocument();
    expect(loadDiff).toHaveBeenCalledWith("workspace-1", "src/renderer/App.tsx");
    expect(await screen.findByText("16 unmodified lines")).toBeInTheDocument();
    // shiki tokenizes lines into per-token <span> children, so getByText on
    // the full source line misses. toHaveTextContent matches concatenated
    // textContent regardless of token carving (same workaround P6.01 used).
    expect(reviewPanel).toHaveTextContent("const oldValue = true;");
    expect(reviewPanel).toHaveTextContent("const newValue = true;");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("browses workspace files via the Files tab and previews a selection", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([
      { path: "src/main/index.ts" },
      { path: "src/main/preload.ts" },
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);
    readWorkspaceFile.mockImplementation((_workspaceId, filePath) =>
      Promise.resolve({
        kind: "text",
        content:
          filePath === "src/main/preload.ts"
            ? "export const preload = true;\n"
            : "export const hello = 'world';\n",
        size: 30,
        mtimeMs: 0
      })
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    // Empty changed-files state → Browse files entry is available behind the picker
    fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browse files" }));

    // The panel opens directly in Files mode
    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(listWorkspaceFiles).toHaveBeenCalledWith("workspace-1");

    // Expand src/ then src/main to reach the file
    fireEvent.click(await screen.findByRole("treeitem", { name: /^src$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^main$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^index\.ts$/ }));

    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/main/index.ts"));
    // The shiki highlighter tokenizes lines into per-token spans, so the line
    // text spans multiple DOM nodes. Query the preview wrapper by aria-label
    // and assert against its concatenated textContent — matches the real
    // production rendering regardless of how the line is carved into tokens.
    const preview = await screen.findByLabelText("Preview of src/main/index.ts");
    expect(preview).toHaveTextContent("export const hello = 'world';");

    fireEvent.click(screen.getByRole("treeitem", { name: /^preload\.ts$/ }));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/main/preload.ts"));
    expect(await screen.findByLabelText("Preview of src/main/preload.ts")).toHaveTextContent(
      "export const preload = true;"
    );

    const tablist = screen.getByRole("tablist", { name: "Open files" });
    expect(within(tablist).getByRole("tab", { name: "index.ts" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(within(tablist).getByRole("tab", { name: "preload.ts" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(within(tablist).getByRole("tab", { name: "index.ts" }));
    expect(await screen.findByLabelText("Preview of src/main/index.ts")).toHaveTextContent(
      "export const hello = 'world';"
    );
  });

  it("opens workspace files via the unified command palette on Cmd+P", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([
      { path: "src/main/index.ts" },
      { path: "src/renderer/App.tsx" }
    ]);
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      content: "export const hello = 'world';\n",
      size: 30,
      mtimeMs: 0
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "p", metaKey: true });

    // The merged palette renders one dialog labeled "Command palette".
    // Files load lazily on first non-empty keystroke (matches Messages).
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "index" } });
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledWith("workspace-1"));
    // Wait for the Files group to populate and pick the matching row.
    // uFuzzy wraps matched substrings in `<mark>`, so the basename's text
    // is split across nodes — use a text-content matcher.
    await within(palette).findByText((_content, node) =>
      node?.classList.contains("command-palette-result-label") === true &&
      node?.textContent === "index.ts"
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/main/index.ts"));
  });

  it("shows a placeholder when a previewed file is binary or too large", async () => {
    listChangedFiles.mockResolvedValue([]);
    listWorkspaceFiles.mockResolvedValue([{ path: "assets/logo.png" }]);
    readWorkspaceFile.mockResolvedValue({ kind: "skipped", reason: "binary", size: 2048 });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browse files" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^assets$/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /^logo\.png$/ }));

    expect(await screen.findByText(/Binary file/i)).toBeInTheDocument();
  });

  it("opens slash autocomplete in the launcher composer without a workspace id", async () => {
    skillsList.mockResolvedValue([
      { name: "plan", description: "Phased plan", source: "user" },
      { name: "impl", description: "Implement code", source: "user" }
    ]);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude Sonnet 4.6" }));
    const input = await screen.findByLabelText<HTMLInputElement>("Task prompt");
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByRole("listbox", { name: "Skill suggestions" })).toBeInTheDocument();
    expect(skillsList).toHaveBeenCalledWith({ provider: "claude" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/plan ");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("toggles active-session agent mode with Shift+Tab and sends plan mode", async () => {
    const completeSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" as const }))
    };
    mockDashboardSnapshot(completeSnapshot);
    workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(completeSnapshot));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    const input = await screen.findByLabelText("Session prompt");
    fireEvent.change(input, { target: { value: "Plan the follow-up" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    expect(screen.getByRole("button", { name: "Agent mode" })).toHaveTextContent("Plan");
    fireEvent.click(screen.getByTitle("Send follow-up"));

    await waitFor(() =>
      expect(sendProviderInput).toHaveBeenCalledWith(
        expect.objectContaining({
          input: "Plan the follow-up\r",
          agentMode: "plan"
        })
      )
    );
    expect(window.localStorage.getItem("argmax.sessionAgentMode.session-1")).toBe("plan");
  });

  it("opens project files via the unified command palette on Cmd+P", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);
    readProjectFile.mockResolvedValue({
      kind: "text",
      content: "export function App() {}\n",
      size: 25,
      mtimeMs: 0
    });

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "p", metaKey: true });

    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "app" } });
    await waitFor(() => expect(listProjectFiles).toHaveBeenCalledWith("project-1"));
    await within(palette).findByText((_content, node) =>
      node?.classList.contains("command-palette-result-label") === true &&
      node?.textContent === "App.tsx"
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    await waitFor(() => expect(readProjectFile).toHaveBeenCalledWith("project-1", "src/renderer/App.tsx"));
  });

  it("opens the launcher review panel in project files mode with Cmd+B", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/main/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "b", metaKey: true });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(screen.queryByText("2 files")).not.toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledWith("project-1");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument()
    );
  });

  it("opens the launcher review panel when Electron sends the Cmd+B menu command", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/main/main.ts" },
      { path: "README.md" }
    ]);

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(menuCommandListener).not.toBeNull();
    act(() => {
      menuCommandListener?.("toggle-sidebar");
    });

    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledWith("project-1");
  });

  it("surfaces project files in the command palette after Cmd+B opens review", async () => {
    listProjectFiles.mockResolvedValue([
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ]);

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "b", metaKey: true });
    expect(await screen.findByRole("complementary", { name: "Review panel" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "p", metaKey: true });

    // Unified palette — type into it and the Files group surfaces matching paths.
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByLabelText("Command palette query");
    fireEvent.change(input, { target: { value: "app" } });
    await within(palette).findByText((_content, node) =>
      node?.classList.contains("command-palette-result-label") === true &&
      node?.textContent === "App.tsx"
    );
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
      expect.objectContaining({ prompt: "Implement PTY launch", provider: "claude" })
    );
    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it("returns to the composer from an open session via the project row", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();

    const projectVisibility = screen.getByRole("button", { name: "Hide Argmax sessions" });
    fireEvent.click(screen.getByRole("button", { name: "Argmax" }));

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(projectVisibility).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByText("Dashboard ready.")).not.toBeInTheDocument();
  });

  it("discards a stale dashboard load when a newer load completes first", async () => {
    let resolveSlow: (data: Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>>) => void = () => {
      throw new Error("slow dashboard load did not start");
    };
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
    dashboardList.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<Awaited<ReturnType<ArgmaxApi["dashboard"]["list"]>>>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(dashboardListSnapshot(fastSnapshot));
    });

    render(<App />);

    // Wait for the first invocation to be in flight.
    await waitFor(() => expect(callCount).toBe(1));

    act(() => {
      dashboardDeltaListener?.({ projects: fastSnapshot.projects });
    });

    // Now resolve the first (slow) load with stale data.
    resolveSlow(dashboardListSnapshot(slowSnapshot));

    // Snapshot should reflect the second (fast) load result, not the stale first.
    expect(await screen.findByRole("button", { name: "Fresh-Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stale-Project" })).not.toBeInTheDocument();
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

  it("hides sidebar session tokens by default and shows them when enabled in Settings", async () => {
    sessionCostSummary.mockResolvedValue({
      sessionId: "session-1",
      modelId: "gpt-5.3-codex",
      tokens: { input: 12_300, output: 4_500, cacheRead: 50_000, cacheWrite: 0 },
      costUsd: 0.012
    });

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    // Push a delta carrying token counts so the workspace-token map populates.
    act(() => {
      dashboardDeltaListener?.({
        sessions: [
          {
            ...((snapshot.sessions[0] ?? missingSession())),
            costUsd: 0.012,
            tokens: { input: 12_300, output: 4_500, cacheRead: 50_000, cacheWrite: 0 }
          }
        ]
      });
    });

    expect(screen.queryByLabelText(/Tokens: 16\.8k/)).not.toBeInTheDocument();

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show session tokens in sidebar" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.sidebar.tokens.visible")).toBe("true")
    );
    // 12.3k + 4.5k = 16.8k displayed; cache reads stay in the tooltip only.
    const cell = await screen.findByLabelText(/Tokens: 16\.8k/);
    expect(cell).toHaveTextContent("16.8k");
    expect(cell.getAttribute("title")).toContain("50k cached");
  });

  it("renders the CostPanel rows and totals on session detail", async () => {
    const costed: DashboardSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "session-1"
          ? {
              ...session,
              costUsd: 4.32,
              tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 }
            }
          : session
      )
    };
    mockDashboardSnapshot(costed);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    const panel = await screen.findByRole("region", { name: "Session cost summary" });
    expect(panel).toBeInTheDocument();

    await waitFor(() => {
      expect(within(panel).getByLabelText(/Total cost:/)).toHaveTextContent("$4.32");
    });

    fireEvent.click(within(panel).getByRole("button", { name: "Toggle cost breakdown" }));

    const inputRow = within(panel).getByRole("row", { name: "Input usage" });
    expect(within(inputRow).getByTitle("Input tokens: 1,200")).toBeInTheDocument();

    const outputRow = within(panel).getByRole("row", { name: "Output usage" });
    expect(within(outputRow).getByTitle("Output tokens: 340")).toBeInTheDocument();

    expect(within(panel).getByRole("row", { name: "Cache read usage" })).toBeInTheDocument();
    expect(within(panel).getByRole("row", { name: "Cache write usage" })).toBeInTheDocument();

    // Cost is projected from session.costUsd on the dashboard delta. The
    // panel must not fire a separate session:costSummary IPC.
    expect(sessionCostSummary).not.toHaveBeenCalled();
  });

  it("hides the chat cost card when disabled in Settings", async () => {
    const costed: DashboardSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "session-1"
          ? {
              ...session,
              costUsd: 4.32,
              tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 }
            }
          : session
      )
    };
    mockDashboardSnapshot(costed);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("region", { name: "Session cost summary" })).toBeInTheDocument();

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show cost in agent chat" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.chat.cost.visible")).toBe("false")
    );
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    await screen.findByRole("button", { name: "Build dashboard" });
    expect(screen.queryByRole("region", { name: "Session cost summary" })).not.toBeInTheDocument();
  });

  it("disables the Open in IDE button when the workspace has no path yet", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "vscode", label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true }
    ]);
    const pathless: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, path: "" }))
    };
    mockDashboardSnapshot(pathless);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    expect(ideButton).toBeDisabled();
    expect(ideButton).toHaveAttribute("title", "Worktree not ready yet");
  });

  it("opens the default IDE when one is configured", async () => {
    window.localStorage.setItem("argmax.defaultIde", "vscode");

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    await waitFor(() => expect(ideButton).not.toBeDisabled());
    fireEvent.click(ideButton);

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "vscode" });
  });

  it("auto-selects the only detected GUI IDE when no default is stored", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "windsurf", label: "Windsurf", appPath: "/Applications/Windsurf.app", hasCli: false },
      { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    await waitFor(() => expect(ideButton.getAttribute("title")).toContain("Windsurf"));
    fireEvent.click(ideButton);

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "windsurf" });
  });

  it("lists every detected IDE in the chevron menu", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const chevron = await screen.findByRole("button", { name: "Choose IDE" });
    await waitFor(() => expect(chevron).not.toBeDisabled());
    fireEvent.click(chevron);

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual(["VS Code", "Cursor", "Terminal"]);
  });

  it("opens the chosen IDE from the chevron menu without changing the default", async () => {
    window.localStorage.setItem("argmax.defaultIde", "vscode");

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const chevron = await screen.findByRole("button", { name: "Choose IDE" });
    await waitFor(() => expect(chevron).not.toBeDisabled());
    fireEvent.click(chevron);
    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Cursor" }));

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "cursor" });
    expect(window.localStorage.getItem("argmax.defaultIde")).toBe("vscode");
  });

  it("settings Tools section writes the chosen default IDE to localStorage", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Integrations");
    await screen.findByRole("heading", { name: "Default IDE" });

    const select = screen.getByRole("combobox", { name: "Default IDE" });
    fireEvent.change(select, { target: { value: "cursor" } });

    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBe("cursor"));
  });

  it("settings Permissions section persists the chosen mode and propagates it through the next launch", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Permissions" });

    fireEvent.click(screen.getByRole("radio", { name: "Ask each time" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.permissionMode")).toBe("ask-each-time")
    );

    // Close Settings to get back to the launcher.
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Gate this run" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: "ask-each-time" })
      )
    );
  });

  it("settings Appearance section switches the font family and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    fireEvent.click(screen.getByRole("button", { name: "Font family" }));
    fireEvent.click(screen.getByRole("button", { name: "JetBrains Mono" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.font.family")).toBe("jetbrains-mono")
    );
    expect(document.documentElement.getAttribute("data-font")).toBe("jetbrains-mono");
  });

  it("settings Appearance section wires the macOS-native options through to the document attribute", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    for (const [label, id] of [
      ["System Mono", "system-mono"],
      ["Menlo", "menlo"],
      ["Monaco", "monaco"],
      ["Lilex", "lilex"]
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Font family" }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(document.documentElement.getAttribute("data-font")).toBe(id)
      );
      expect(window.localStorage.getItem("argmax.font.family")).toBe(id);
    }
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Split target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Below target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
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

  it("does not start a sidebar workspace drag while the launcher is showing", async () => {
    render(<App />);

    const row = await screen.findByRole("button", { name: "Build dashboard" });
    expect(row).toHaveAttribute("draggable", "false");

    const setData = vi.fn();
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData,
        setDragImage: vi.fn(),
        effectAllowed: "move"
      }
    });

    expect(setData).not.toHaveBeenCalled();
    expect(document.querySelector(".multigrid-drop-overlay")).toBeNull();
  });

  it("keeps the current session and opens a launcher pane to the right from New session", async () => {
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

  it("defaults the new-session toggle to 'Open in grid' on first launch", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings();

    expect(await screen.findByRole("radio", { name: "Open in grid" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Open full view" })).not.toBeChecked();
    expect(window.localStorage.getItem("argmax.newSessionMode")).toBe("embedded");
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Second pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
    };
    const thirdSession: DashboardSnapshot["sessions"][number] = {
      id: "session-3",
      workspaceId: "workspace-3",
      provider: "claude",
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-3",
      prompt: "Third pane",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:05:00.000Z",
      lastActivityAt: "2026-05-08T16:05:00.000Z",
      preferred: false
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace, thirdWorkspace],
      sessions: [...snapshot.sessions, secondSession, thirdSession]
    });

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

  it("drops a sidebar session onto a grid zone even when dataTransfer getData is empty", async () => {
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Drop target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
    };
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });

    fireEvent.dragStart(screen.getByRole("button", { name: "Drop target" }), {
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
      types: [WORKSPACE_DRAG_MIME],
      getData: vi.fn(() => ""),
      dropEffect: "move"
    };
    expect(document.querySelector('.multigrid-drop-zone[data-position="replace"]')).toBeNull();
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "Resize target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
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
      value: () => ({ width: 900, height: 600, top: 0, right: 900, bottom: 600, left: 0, x: 0, y: 0, toJSON: () => ({}) })
    });
    const before = row.style.gridTemplateColumns;

    fireEvent.mouseDown(handle, { clientX: 450 });
    fireEvent.mouseMove(document, { clientX: 560 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(row.style.gridTemplateColumns).not.toBe(before);
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
      modelLabel: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      permissionMode: "auto-approve",
      providerConversationId: "session-2",
      prompt: "CmdW target",
      state: "complete",
      attention: "review-ready",
      startedAt: "2026-05-08T16:00:00.000Z",
      completedAt: "2026-05-08T16:04:00.000Z",
      lastActivityAt: "2026-05-08T16:04:00.000Z",
      preferred: false
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

function missingCheck(): never {
  throw new Error("Test snapshot must include a check");
}
