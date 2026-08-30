import { fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { ArgmaxApi, DashboardDelta, DashboardSnapshot, MenuCommand } from "../shared/types.js";
import {
  dashboardListSnapshot,
  defaultDashboardSnapshot,
  missingCheck,
  missingSession,
  missingWorkspace,
  primaryProject,
  secondProject,
  workspaceStatusSnapshot
} from "./fixtures/dashboardSnapshot.js";

// Resolve the panels App.tsx mounts through `React.lazy` before any test runs.
//
// In the app these warm on an idle callback after first paint
// (useLazyOverlayPrefetch), so a real user's first Settings open hits a cached
// module. jsdom has no `requestIdleCallback`, so the hook falls back to a
// 400/600 ms timer chain and a test clicks Settings long before it fires.
// paying the module's full first-load inside the assertion. That load is ~700 ms
// for SettingsPanel alone on an idle machine and more under the full suite's
// parallel workers, which overruns Testing Library's 1 s `findBy` ceiling
// nondeterministically. Warming here moves the cost outside every assertion
// window instead of widening the window and losing the ceiling's value.
//
// Top-level await, so it happens once per worker at import time. Only files
// that render <App /> import this harness, so lib-only tests never pay it.
await Promise.all([
  import("../renderer/components/SettingsPanel.js"),
  import("../renderer/components/CommandPalette.js"),
  import("../renderer/components/ReviewPanel.js")
]);

export const snapshot = defaultDashboardSnapshot;

export {
  dashboardListSnapshot,
  defaultDashboardSnapshot,
  missingCheck,
  missingSession,
  missingWorkspace,
  primaryProject,
  secondProject,
  workspaceStatusSnapshot
};

export type { ArgmaxApi, DashboardDelta, DashboardSnapshot };

export type SettingsGroup = "General" | "Agents" | "Integrations" | "System";

export type AppTestMockFn<T extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<T>>;

export type AppTestMocks = {
  createCurrentWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createCurrent"]>;
  createIsolatedWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createIsolated"]>;
  createScratchWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createScratch"]>;
  autotitleWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["autoTitle"]>;
  archiveWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["archive"]>;
  dashboardList: AppTestMockFn<ArgmaxApi["dashboard"]["list"]>;
  dashboardDeltaUnsubscribe: AppTestMockFn<() => void>;
  launchProvider: AppTestMockFn<ArgmaxApi["providers"]["launch"]>;
  approvalsPending: AppTestMockFn<ArgmaxApi["approvals"]["pending"]>;
  approvalsResolve: AppTestMockFn<ArgmaxApi["approvals"]["resolve"]>;
  pickProjectFolder: AppTestMockFn<ArgmaxApi["projects"]["pickFolder"]>;
  listBranches: AppTestMockFn<ArgmaxApi["projects"]["listBranches"]>;
  listChangedFiles: AppTestMockFn<ArgmaxApi["review"]["listChangedFiles"]>;
  loadDiff: AppTestMockFn<ArgmaxApi["review"]["loadDiff"]>;
  listWorkspaceFiles: AppTestMockFn<ArgmaxApi["workspace"]["listFiles"]>;
  readWorkspaceFile: AppTestMockFn<ArgmaxApi["workspace"]["readFile"]>;
  listProjectFiles: AppTestMockFn<ArgmaxApi["workspace"]["listFiles"]>;
  readProjectFile: AppTestMockFn<ArgmaxApi["workspace"]["readFile"]>;
  writeProjectFile: AppTestMockFn<ArgmaxApi["workspace"]["writeFile"]>;
  sessionEventsSince: AppTestMockFn<ArgmaxApi["session"]["eventsSince"]>;
  sessionAgentEvents: AppTestMockFn<ArgmaxApi["session"]["agentEvents"]>;
  sessionCostSummary: AppTestMockFn<ArgmaxApi["session"]["costSummary"]>;
  sendProviderInput: AppTestMockFn<ArgmaxApi["providers"]["sendInput"]>;
  terminateProvider: AppTestMockFn<ArgmaxApi["providers"]["terminate"]>;
  providersDiscover: AppTestMockFn<ArgmaxApi["providers"]["discover"]>;
  diagnosticsStub: AppTestMockFn<ArgmaxApi["system"]["diagnostics"]>;
  vacuumDatabaseStub: AppTestMockFn<ArgmaxApi["system"]["vacuumDatabase"]>;
  workspaceStatus: AppTestMockFn<ArgmaxApi["workspaces"]["status"]>;
  skillsList: AppTestMockFn<ArgmaxApi["skills"]["list"]>;
  openInIde: AppTestMockFn<ArgmaxApi["workspaces"]["openInIde"]>;
  listDetectedIdes: AppTestMockFn<ArgmaxApi["system"]["listDetectedIdes"]>;
  setWorkspaceIcon: AppTestMockFn<ArgmaxApi["workspaces"]["setIcon"]>;
  setPriorityDismissed: AppTestMockFn<ArgmaxApi["workspaces"]["setPriorityDismissed"]>;
};

export let createCurrentWorkspace: AppTestMocks["createCurrentWorkspace"];
export let createIsolatedWorkspace: AppTestMocks["createIsolatedWorkspace"];
export let createScratchWorkspace: AppTestMocks["createScratchWorkspace"];
export let autotitleWorkspace: AppTestMocks["autotitleWorkspace"];
export let archiveWorkspace: AppTestMocks["archiveWorkspace"];
export let dashboardList: AppTestMocks["dashboardList"];
export let dashboardDeltaListener: ((delta: DashboardDelta) => void) | null = null;
export let dashboardDeltaUnsubscribe: AppTestMocks["dashboardDeltaUnsubscribe"];
export let launchProvider: AppTestMocks["launchProvider"];
export let approvalsPending: AppTestMocks["approvalsPending"];
export let approvalsResolve: AppTestMocks["approvalsResolve"];
export let pickProjectFolder: AppTestMocks["pickProjectFolder"];
export let listBranches: AppTestMocks["listBranches"];
export let listChangedFiles: AppTestMocks["listChangedFiles"];
export let loadDiff: AppTestMocks["loadDiff"];
export let listWorkspaceFiles: AppTestMocks["listWorkspaceFiles"];
export let readWorkspaceFile: AppTestMocks["readWorkspaceFile"];
export let listProjectFiles: AppTestMocks["listProjectFiles"];
export let readProjectFile: AppTestMocks["readProjectFile"];
export let writeProjectFile: AppTestMocks["writeProjectFile"];
export let sessionEventsSince: AppTestMocks["sessionEventsSince"];
export let sessionAgentEvents: AppTestMocks["sessionAgentEvents"];
export let sessionCostSummary: AppTestMocks["sessionCostSummary"];
export let sendProviderInput: AppTestMocks["sendProviderInput"];
export let terminateProvider: AppTestMocks["terminateProvider"];
export let providersDiscover: AppTestMocks["providersDiscover"];
export let diagnosticsStub: AppTestMocks["diagnosticsStub"];
export let vacuumDatabaseStub: AppTestMocks["vacuumDatabaseStub"];
export let workspaceStatus: AppTestMocks["workspaceStatus"];
export let skillsList: AppTestMocks["skillsList"];
export let openInIde: AppTestMocks["openInIde"];
export let listDetectedIdes: AppTestMocks["listDetectedIdes"];
export let setWorkspaceIcon: AppTestMocks["setWorkspaceIcon"];
export let setPriorityDismissed: AppTestMocks["setPriorityDismissed"];
export let menuCommandListener: ((command: MenuCommand) => void) | null = null;

export function setupAppTestMocks(): void {
  window.localStorage.clear();
  // Pre-seed the boot-collapse markers so existing App tests render the
  // sidebar with projects and session groups expanded (the pre-fix behavior).
  // Sidebar tests that exercise the boot-collapse seeds clear these markers
  // themselves.
  window.sessionStorage.setItem("argmax.sidebar.bootCollapseSeeded", "1");
  window.sessionStorage.setItem("argmax.sidebar.bootGroupCollapseSeeded", "1");
  // Disable the sidebar Priority section (default-on in the app): it renders
  // attention-worthy workspaces a second time above the project groups, which
  // would break the single-match role queries App tests rely on. Priority
  // behavior is covered directly in Sidebar.test.tsx.
  window.localStorage.setItem("argmax.sidebar.priority.visible", "false");
  createCurrentWorkspace = vi.fn<ArgmaxApi["workspaces"]["createCurrent"]>().mockResolvedValue(
    snapshot.workspaces[0] ?? missingWorkspace()
  );
  createIsolatedWorkspace = vi.fn<ArgmaxApi["workspaces"]["createIsolated"]>().mockResolvedValue(
    snapshot.workspaces[0] ?? missingWorkspace()
  );
  createScratchWorkspace = vi.fn<ArgmaxApi["workspaces"]["createScratch"]>().mockResolvedValue(
    snapshot.workspaces[0] ?? missingWorkspace()
  );
  autotitleWorkspace = vi.fn<ArgmaxApi["workspaces"]["autoTitle"]>().mockResolvedValue({ ok: true });
  archiveWorkspace = vi.fn<ArgmaxApi["workspaces"]["archive"]>().mockImplementation(({ workspaceId }) =>
    Promise.resolve({
      ...(snapshot.workspaces.find((w) => w.id === workspaceId) ?? snapshot.workspaces[0] ?? missingWorkspace()),
      state: "archived"
    })
  );
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
      providerInvocationId: null,
      providerRequestId: null,
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
  listBranches = vi.fn<ArgmaxApi["projects"]["listBranches"]>().mockResolvedValue(["main"]);
  sessionEventsSince = vi.fn<ArgmaxApi["session"]["eventsSince"]>().mockResolvedValue({
    events: snapshot.events,
    rawOutputs: snapshot.rawOutputs,
    eventCursor: 0,
    rawOutputCursor: 0
  });
  sessionAgentEvents = vi.fn<ArgmaxApi["session"]["agentEvents"]>().mockResolvedValue({
    events: snapshot.events,
    rawOutputs: snapshot.rawOutputs,
    eventCursor: 0,
    rawOutputCursor: 0
  });
  sessionCostSummary = vi.fn<ArgmaxApi["session"]["costSummary"]>().mockResolvedValue({
    sessionId: "session-1",
    modelId: "gpt-5.5",
    tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 },
    costUsd: 0.012
  });
  sendProviderInput = vi.fn<ArgmaxApi["providers"]["sendInput"]>().mockResolvedValue({ ok: true, queued: false });
  terminateProvider = vi.fn<ArgmaxApi["providers"]["terminate"]>().mockResolvedValue({ ok: true });
  providersDiscover = vi.fn<ArgmaxApi["providers"]["discover"]>().mockResolvedValue([]);
  diagnosticsStub = vi.fn<ArgmaxApi["system"]["diagnostics"]>().mockResolvedValue({
    appVersion: "0.1.0",
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
        learnings: 5,
        usageEvents: 18
      },
      walBytes: 1024 * 128,
      walAutocheckpoint: 1000
    },
    sqlitePragmas: {
      journalMode: "wal",
      foreignKeys: 1,
      synchronous: 1,
      busyTimeout: 5000,
      walAutocheckpoint: 1000
    },
    runtime: {
      rssBytes: 0,
      openFileDescriptors: 0,
      tokioTrackedTasks: 0
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
  menuCommandListener = null;
  workspaceStatus = vi.fn<ArgmaxApi["workspaces"]["status"]>().mockResolvedValue(workspaceStatusSnapshot(snapshot));
  listChangedFiles = vi.fn<ArgmaxApi["review"]["listChangedFiles"]>().mockResolvedValue([]);
  loadDiff = vi.fn<ArgmaxApi["review"]["loadDiff"]>().mockResolvedValue({
    workspaceId: "workspace-1",
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
  listProjectFiles = vi.fn<ArgmaxApi["workspace"]["listFiles"]>().mockResolvedValue([]);
  readProjectFile = vi.fn<ArgmaxApi["workspace"]["readFile"]>().mockResolvedValue({
    kind: "skipped",
    reason: "not-a-file"
  } as const);
  writeProjectFile = vi.fn<ArgmaxApi["workspace"]["writeFile"]>().mockResolvedValue({
    ok: true,
    mtimeMs: 0,
    size: 0
  });
  skillsList = vi.fn<ArgmaxApi["skills"]["list"]>().mockResolvedValue([]);
  openInIde = vi.fn<ArgmaxApi["workspaces"]["openInIde"]>().mockResolvedValue({ ok: true });
  listDetectedIdes = vi.fn<ArgmaxApi["system"]["listDetectedIdes"]>().mockResolvedValue([
    { id: "vscode", label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true },
    { id: "cursor", label: "Cursor", appPath: "/Applications/Cursor.app", hasCli: true },
    { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
  ]);
  setWorkspaceIcon = vi
    .fn<ArgmaxApi["workspaces"]["setIcon"]>()
    .mockImplementation(({ workspaceId, icon, iconColor }) =>
      Promise.resolve({
        ...(snapshot.workspaces[0] ?? missingWorkspace()),
        id: workspaceId,
        icon,
        iconColor
      })
    );
  setPriorityDismissed = vi
    .fn<ArgmaxApi["workspaces"]["setPriorityDismissed"]>()
    .mockImplementation(({ workspaceId, dismissed }) =>
      Promise.resolve({
        ...(snapshot.workspaces.find((item) => item.id === workspaceId) ??
          snapshot.workspaces[0] ??
          missingWorkspace()),
        id: workspaceId,
        priorityDismissedAt: dismissed ? new Date().toISOString() : null,
        priorityAddedAt: null
      })
    );

  window.argmax = {
    dashboard: {
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
      remove: () => Promise.resolve(),
      updateSettings: () => Promise.resolve(primaryProject()),
      listBranches,
      refreshBranch: () => Promise.resolve(primaryProject()),
      switchBranch: () => Promise.resolve(primaryProject())
    },
    workspaces: {
      createIsolated: createIsolatedWorkspace,
      createCurrent: createCurrentWorkspace,
      createScratch: createScratchWorkspace,
      refreshStatus: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
      status: workspaceStatus,
      keep: () => Promise.resolve(snapshot.workspaces[0] ?? missingWorkspace()),
      archive: archiveWorkspace,
      openInIde: openInIde,
      autoTitle: autotitleWorkspace,
      setPinned: ({ workspaceId, pinned }) =>
        Promise.resolve({
          ...(snapshot.workspaces[0] ?? missingWorkspace()),
          id: workspaceId,
          pinned
        }),
      setPriorityDismissed,
      setPriorityAdded: ({ workspaceId, added }) =>
        Promise.resolve({
          ...(snapshot.workspaces[0] ?? missingWorkspace()),
          id: workspaceId,
          priorityAddedAt: added ? new Date().toISOString() : null,
          priorityDismissedAt: null
        }),
      setLabel: ({ workspaceId, taskLabel }) =>
        Promise.resolve({
          ...(snapshot.workspaces[0] ?? missingWorkspace()),
          id: workspaceId,
          taskLabel
        }),
      setIcon: setWorkspaceIcon
    },
    providers: {
      discover: providersDiscover,
      launch: launchProvider,
      sendInput: sendProviderInput,
      resize: () => Promise.resolve({ ok: true }),
      terminate: terminateProvider,
      cancelQueuedMessage: () => Promise.resolve({ ok: true }),
      sendQueuedMessageNow: () => Promise.resolve({ ok: true, queued: false })
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
      agentEvents: sessionAgentEvents,
      fork: () => Promise.reject(new Error("session fork not stubbed")),
      costSummary: sessionCostSummary,
      search: () => Promise.resolve([])
    },
    review: {
      listChangedFiles,
      loadDiff
    },
    workspace: {
      listFiles: (target) => target.kind === "project" ? listProjectFiles(target) : listWorkspaceFiles(target),
      readFile: (target, path) => target.kind === "project" ? readProjectFile(target, path) : readWorkspaceFile(target, path),
      writeFile: (target, path, content, mtime) => target.kind === "project"
        ? writeProjectFile(target, path, content, mtime)
        : Promise.resolve({ ok: true, mtimeMs: 0, size: 0 } as const),
      statFile: () => Promise.resolve({ mtimeMs: 0, size: 0 }),
      grepContent: () => Promise.resolve({ files: [], truncated: false })
    },
    checks: {
      run: () => Promise.resolve(missingCheck())
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
      vacuumDatabase: vacuumDatabaseStub,
      setTheme: () => Promise.resolve({ ok: true })
    },
    remote: {
      getStatus: () => Promise.reject(new Error("remote status unavailable in tests")),
      setConfig: () => Promise.reject(new Error("remote config unavailable in tests")),
      testNotification: () => Promise.resolve({ ok: true })
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
    sync: {
      getStatus: vi.fn(() => Promise.resolve({
          config: { claude: false, codex: false, cursor: false, opencode: false, windowHours: 24 },
          supportedProviders: ["claude"],
          lastRunAt: null,
          importedCount: 0,
          lastError: null
        })),
      setConfig: vi.fn(() => Promise.resolve({
          config: { claude: false, codex: false, cursor: false, opencode: false, windowHours: 24 },
          supportedProviders: ["claude"],
          lastRunAt: null,
          importedCount: 0,
          lastError: null
        })),
      runNow: vi.fn(() => Promise.resolve({
          config: { claude: false, codex: false, cursor: false, opencode: false, windowHours: 24 },
          supportedProviders: ["claude"],
          lastRunAt: null,
          importedCount: 0,
          lastError: null
        }))
    },
    browser: {
      open: () => Promise.resolve({ ok: true }),
      navigate: () => Promise.resolve({ ok: true }),
      back: () => Promise.resolve({ ok: true }),
      forward: () => Promise.resolve({ ok: true }),
      reload: () => Promise.resolve({ ok: true }),
      setBounds: () => Promise.resolve({ ok: true }),
      close: () => Promise.resolve({ ok: true }),
      fillCredentials: () => Promise.resolve({ ok: true, itemTitle: "Test Login" }),
      onState: () => () => undefined
    }
  };
}

export function mockDashboardSnapshot(data: DashboardSnapshot): void {
  dashboardList.mockResolvedValue(dashboardListSnapshot(data));
  sessionEventsSince.mockResolvedValue({
    events: data.events,
    rawOutputs: data.rawOutputs,
    eventCursor: 0,
    rawOutputCursor: 0
  });
  sessionAgentEvents.mockResolvedValue({
    events: data.events,
    rawOutputs: data.rawOutputs,
    eventCursor: 0,
    rawOutputCursor: 0
  });
  approvalsPending.mockResolvedValue(data.approvals);
  workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(data));
}

export async function openSettings(group: SettingsGroup = "General"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Argmax menu" }));
  const menu = await screen.findByRole("menu", { name: "Argmax menu" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Settings/ }));
  await screen.findByRole("heading", { name: "Settings" });
  if (group === "General") return;

  const settingsGroups = screen.getByRole("complementary", { name: "Settings groups" });
  fireEvent.click(within(settingsGroups).getByRole("button", { name: new RegExp(`\\b${group}\\b`) }));
  if (group === "System") {
    await screen.findByText("No learnings captured yet. Complete a session to start filling this list.");
  }
}
