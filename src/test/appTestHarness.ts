import { act, fireEvent, screen, within } from "@testing-library/react";
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
  sessionRow,
  workspaceRow,
  workspaceStatusSnapshot
} from "./fixtures/dashboardSnapshot.js";
import { usageRemainingFixture } from "./fixtures/usageRemaining.js";
import { usageSummaryFixture, usageSummaryFor } from "./fixtures/usageSummary.js";
import { demoActivitySummary } from "../renderer/demoActivity.js";
import { resetLauncherSurfaceForTests } from "../renderer/state/launcherSurface.js";
import { resetOverlaysForTests } from "../renderer/state/overlays.js";
import { resetPaneGridForTests } from "../renderer/state/paneGrid.js";
import { resetSidebarChromeForTests } from "../renderer/state/sidebarChrome.js";
import { resetToastForTests } from "../renderer/state/toast.js";
import { resetWorkspaceDragForTests } from "../renderer/state/workspaceDrag.js";
import { resetLedgerPageStateForTests } from "../renderer/lib/ledgerPageState.js";
import { resetLedgerPrefetchForTests } from "../renderer/lib/ledgerPrefetch.js";
import { resetSessionUnreadForTests } from "../renderer/lib/sessionUnread.js";
import { resetMascotVisibilityForTests } from "../renderer/lib/mascotVisibility.js";

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
  import("../renderer/components/scheduled/ScheduledTasksPanel.js"),
  import("../renderer/components/usage/UsagePanel.js"),
  import("../renderer/components/CommandPalette.js"),
  import("../renderer/components/ReviewPanel.js")
]);

export const snapshot = defaultDashboardSnapshot;

export { usageRemainingFixture, usageSummaryFixture, usageSummaryFor };

export {
  dashboardListSnapshot,
  defaultDashboardSnapshot,
  missingCheck,
  missingSession,
  missingWorkspace,
  primaryProject,
  secondProject,
  sessionRow,
  workspaceRow,
  workspaceStatusSnapshot
};

export type { ArgmaxApi, DashboardDelta, DashboardSnapshot };

export type SettingsGroup =
  | "General"
  | "Appearance"
  | "Agents"
  | "Projects"
  | "Integrations"
  | "Advanced";

export type AppTestMockFn<T extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<T>>;

export let createCurrentWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createCurrent"]>;
export let createIsolatedWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createIsolated"]>;
export let createScratchWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["createScratch"]>;
export let autotitleWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["autoTitle"]>;
export let archiveWorkspace: AppTestMockFn<ArgmaxApi["workspaces"]["archive"]>;
export let dashboardList: AppTestMockFn<ArgmaxApi["dashboard"]["list"]>;
export let dashboardDeltaListener: ((delta: DashboardDelta) => void) | null = null;
export let dashboardDeltaUnsubscribe: AppTestMockFn<() => void>;
export let launchProvider: AppTestMockFn<ArgmaxApi["providers"]["launch"]>;
let approvalsPending: AppTestMockFn<ArgmaxApi["approvals"]["pending"]>;
let approvalsResolve: AppTestMockFn<ArgmaxApi["approvals"]["resolve"]>;
export let questionsResolve: AppTestMockFn<ArgmaxApi["questions"]["resolve"]>;
export let pickProjectFolder: AppTestMockFn<ArgmaxApi["projects"]["pickFolder"]>;
export let listBranches: AppTestMockFn<ArgmaxApi["projects"]["listBranches"]>;
export let listChangedFiles: AppTestMockFn<ArgmaxApi["review"]["listChangedFiles"]>;
export let loadDiff: AppTestMockFn<ArgmaxApi["review"]["loadDiff"]>;
export let listWorkspaceFiles: AppTestMockFn<ArgmaxApi["workspace"]["listFiles"]>;
export let readWorkspaceFile: AppTestMockFn<ArgmaxApi["workspace"]["readFile"]>;
export let listProjectFiles: AppTestMockFn<ArgmaxApi["workspace"]["listFiles"]>;
export let readProjectFile: AppTestMockFn<ArgmaxApi["workspace"]["readFile"]>;
export let writeProjectFile: AppTestMockFn<ArgmaxApi["workspace"]["writeFile"]>;
export let sessionEventsSince: AppTestMockFn<ArgmaxApi["session"]["eventsSince"]>;
export let sessionAgentEvents: AppTestMockFn<ArgmaxApi["session"]["agentEvents"]>;
let sessionCostSummary: AppTestMockFn<ArgmaxApi["session"]["costSummary"]>;
export let sendProviderInput: AppTestMockFn<ArgmaxApi["providers"]["sendInput"]>;
export let steerProviderInput: AppTestMockFn<ArgmaxApi["providers"]["steerInput"]>;
export let terminateProvider: AppTestMockFn<ArgmaxApi["providers"]["terminate"]>;
export let providersDiscover: AppTestMockFn<ArgmaxApi["providers"]["discover"]>;
export let diagnosticsStub: AppTestMockFn<ArgmaxApi["system"]["diagnostics"]>;
let vacuumDatabaseStub: AppTestMockFn<ArgmaxApi["system"]["vacuumDatabase"]>;
export let setNotificationsEnabledStub: AppTestMockFn<ArgmaxApi["system"]["setNotificationsEnabled"]>;
export let agentToolsStub: AppTestMockFn<ArgmaxApi["settings"]["agentTools"]>;
export let setBrowserToolsStub: AppTestMockFn<ArgmaxApi["settings"]["setBrowserTools"]>;
let setKeepAwakeStub: AppTestMockFn<ArgmaxApi["system"]["setKeepAwake"]>;
let multitaskStub: AppTestMockFn<ArgmaxApi["session"]["multitask"]>;
export let testNotificationStub: AppTestMockFn<ArgmaxApi["system"]["testNotification"]>;
export let workspaceStatus: AppTestMockFn<ArgmaxApi["workspaces"]["status"]>;
export let skillsList: AppTestMockFn<ArgmaxApi["skills"]["list"]>;
export let connectionsList: AppTestMockFn<ArgmaxApi["connections"]["list"]>;
export let openInIde: AppTestMockFn<ArgmaxApi["workspaces"]["openInIde"]>;
export let listDetectedIdes: AppTestMockFn<ArgmaxApi["system"]["listDetectedIdes"]>;
export let setWorkspaceIcon: AppTestMockFn<ArgmaxApi["workspaces"]["setIcon"]>;
export let setPriorityDismissed: AppTestMockFn<ArgmaxApi["workspaces"]["setPriorityDismissed"]>;
/** Override with `usageSummary.mockResolvedValue(usageSummaryFixture({ … }))`
 *  to put the Usage page into a specific state. */
export let usageSummary: AppTestMockFn<ArgmaxApi["usage"]["summary"]>;
export let usageRemaining: AppTestMockFn<ArgmaxApi["usage"]["remaining"]>;
export let activitySummary: AppTestMockFn<ArgmaxApi["activity"]["summary"]>;
export let menuCommandListener: ((command: MenuCommand) => void) | null = null;

type Routine = Awaited<ReturnType<ArgmaxApi["routines"]["upsert"]>>;

/** A scheduled task with every field filled in. No test reads the padding —
 *  it is here so the five routine channels return one shape. */
function routineStub(overrides: Partial<Routine> & { id: string }): Routine {
  const now = new Date().toISOString();
  return {
    name: "",
    projectId: "",
    prompt: "",
    provider: "claude",
    modelLabel: "",
    modelId: "",
    worktree: true,
    runTarget: "worktree",
    lastSessionId: null,
    arcId: null,
    cronExpr: null,
    runOnceAt: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    createdBy: "user",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function syncStatusStub(): Awaited<ReturnType<ArgmaxApi["sync"]["getStatus"]>> {
  return {
    config: { claude: false, codex: false, cursor: false, opencode: false, grok: false, windowHours: 24 },
    supportedProviders: ["claude"],
    lastRunAt: null,
    importedCount: 0,
    lastError: null
  };
}

/** One whole page of a session's transcript: no cursor to follow, nothing deleted. */
function eventPageStub(data: DashboardSnapshot): Awaited<ReturnType<ArgmaxApi["session"]["eventsSince"]>> {
  return {
    events: data.events,
    rawOutputs: data.rawOutputs,
    eventCursor: 0,
    rawOutputCursor: 0,
    changeCursor: null,
    deletedEventIds: [],
    deletedRawOutputIds: [],
    resetRequired: false,
    hasMore: false
  };
}

export function setupAppTestMocks(): void {
  window.localStorage.clear();
  // Shell state lives in modules that outlive an unmount, so a value one test
  // leaves behind would otherwise decide what the next one renders.
  resetOverlaysForTests();
  resetLedgerPageStateForTests();
  resetLedgerPrefetchForTests();
  resetLauncherSurfaceForTests();
  resetPaneGridForTests();
  resetToastForTests();
  resetWorkspaceDragForTests();
  resetSidebarChromeForTests();
  resetSessionUnreadForTests();
  resetMascotVisibilityForTests();
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
      workspace: {
        ...(snapshot.workspaces.find((w) => w.id === workspaceId) ?? snapshot.workspaces[0] ?? missingWorkspace()),
        state: "archived"
      },
      recoveryPath: "/tmp/workspace-archive/workspace-1"
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
  questionsResolve = vi.fn<ArgmaxApi["questions"]["resolve"]>().mockImplementation(({ sessionId, requestId, dismissed }) =>
    Promise.resolve({ sessionId, requestId, status: dismissed ? "dismissed" : "answered" })
  );
  pickProjectFolder = vi.fn<ArgmaxApi["projects"]["pickFolder"]>().mockResolvedValue({
    cancelled: false,
    project: primaryProject()
  });
  listBranches = vi.fn<ArgmaxApi["projects"]["listBranches"]>().mockResolvedValue(["main"]);
  sessionEventsSince = vi.fn<ArgmaxApi["session"]["eventsSince"]>().mockResolvedValue(eventPageStub(snapshot));
  sessionAgentEvents = vi.fn<ArgmaxApi["session"]["agentEvents"]>().mockResolvedValue(eventPageStub(snapshot));
  sessionCostSummary = vi.fn<ArgmaxApi["session"]["costSummary"]>().mockResolvedValue({
    sessionId: "session-1",
    modelId: "gpt-5.5",
    tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 },
    costUsd: 0.012
  });
  sendProviderInput = vi.fn<ArgmaxApi["providers"]["sendInput"]>().mockResolvedValue({ ok: true, queued: false });
  steerProviderInput = vi.fn<ArgmaxApi["providers"]["steerInput"]>().mockResolvedValue({ ok: true, queued: false });
  terminateProvider = vi.fn<ArgmaxApi["providers"]["terminate"]>().mockResolvedValue({ ok: true });
  providersDiscover = vi.fn<ArgmaxApi["providers"]["discover"]>().mockResolvedValue([]);
  diagnosticsStub = vi.fn<ArgmaxApi["system"]["diagnostics"]>().mockResolvedValue({
    appVersion: "0.1.0",
    sqliteVersion: "3.45.0",
    databasePath: "/tmp/argmax.sqlite",
    archiveRecoveryPath: "/tmp/workspace-archive",
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
        seq: 1,
        timestamp: "2026-05-14T11:00:00.000Z",
        level: "info",
        scope: "providers.session",
        message: "session launched",
        fields: { sessionId: "session-1" }
      },
      {
        seq: 2,
        timestamp: "2026-05-14T11:00:05.000Z",
        level: "warn",
        scope: "gh.poller",
        message: "ghService.refresh failed",
        fields: {}
      }
    ]
  });
  vacuumDatabaseStub = vi.fn<ArgmaxApi["system"]["vacuumDatabase"]>().mockResolvedValue({ ok: true });
  setNotificationsEnabledStub = vi
    .fn<ArgmaxApi["system"]["setNotificationsEnabled"]>()
    .mockResolvedValue({ ok: true });
  agentToolsStub = vi
    .fn<ArgmaxApi["settings"]["agentTools"]>()
    .mockResolvedValue({ browserTools: true });
  setBrowserToolsStub = vi
    .fn<ArgmaxApi["settings"]["setBrowserTools"]>()
    .mockImplementation(({ enabled }) => Promise.resolve({ browserTools: enabled }));
  setKeepAwakeStub = vi.fn<ArgmaxApi["system"]["setKeepAwake"]>().mockResolvedValue({ ok: true });
  testNotificationStub = vi.fn<ArgmaxApi["system"]["testNotification"]>().mockResolvedValue({ ok: true });
  multitaskStub = vi.fn<ArgmaxApi["session"]["multitask"]>().mockResolvedValue({
    sessionId: "multitask-session",
    workspaceId: "multitask-workspace",
    taskLabel: "Side fix"
  });
  menuCommandListener = null;
  workspaceStatus = vi.fn<ArgmaxApi["workspaces"]["status"]>().mockResolvedValue(workspaceStatusSnapshot(snapshot));
  listChangedFiles = vi.fn<ArgmaxApi["review"]["listChangedFiles"]>().mockResolvedValue([]);
  loadDiff = vi.fn<ArgmaxApi["review"]["loadDiff"]>().mockResolvedValue({
    workspaceId: "workspace-1",
    filePath: null,
    content: "",
    revision: "test-revision"
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
    ok: "true",
    mtimeMs: 0,
    size: 0
  });
  skillsList = vi.fn<ArgmaxApi["skills"]["list"]>().mockResolvedValue([]);
  connectionsList = vi.fn<ArgmaxApi["connections"]["list"]>().mockResolvedValue([]);
  usageSummary = vi
    .fn<ArgmaxApi["usage"]["summary"]>()
    .mockImplementation((input) => Promise.resolve(usageSummaryFor(input)));
  usageRemaining = vi
    .fn<ArgmaxApi["usage"]["remaining"]>()
    .mockResolvedValue(usageRemainingFixture());
  activitySummary = vi
    .fn<ArgmaxApi["activity"]["summary"]>()
    .mockImplementation((input) => Promise.resolve(demoActivitySummary(input)));
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

  const deltaListeners = new Set<(delta: DashboardDelta) => void>();
  window.argmax = {
    dashboard: {
      list: dashboardList,
      onDelta: (listener) => {
        deltaListeners.add(listener);
        dashboardDeltaListener = (delta) => { for (const subscriber of [...deltaListeners]) subscriber(delta); };
        return () => { deltaListeners.delete(listener); dashboardDeltaUnsubscribe(); };
      }
    },
    usage: {
      summary: usageSummary,
      remaining: usageRemaining
    },
    activity: {
      summary: activitySummary
    },
    routines: {
      list: () => Promise.resolve([]),
      upsert: (input) =>
        Promise.resolve(
          routineStub({
            ...input,
            runTarget: input.runTarget ?? (input.worktree ? "worktree" : "new_session"),
            enabled: input.enabled ?? true
          })
        ),
      delete: () => Promise.resolve(null),
      setEnabled: (id, enabled) => Promise.resolve(routineStub({ id, enabled })),
      runNow: (id) => Promise.resolve(routineStub({ id, enabled: false })),
      resetSession: (id) =>
        Promise.resolve(routineStub({ id, worktree: false, runTarget: "same_session" }))
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
      steerInput: steerProviderInput,
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
    questions: {
      resolve: questionsResolve
    },
    session: {
      eventsSince: sessionEventsSince,
      agentEvents: sessionAgentEvents,
      fork: () => Promise.reject(new Error("session fork not stubbed")),
      multitask: multitaskStub,
      clear: () => Promise.reject(new Error("session clear not stubbed")),
      suggestFollowUp: () => Promise.resolve({ suggestion: null }),
      costSummary: sessionCostSummary,
      search: () => Promise.resolve([])
    },
    goals: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("Goal not stubbed")),
      clear: () => Promise.resolve(null),
    },
    arcs: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("Arc not stubbed")),
      create: () => Promise.reject(new Error("Arc not stubbed")),
      update: () => Promise.reject(new Error("Arc not stubbed")),
      setState: () => Promise.reject(new Error("Arc not stubbed")),
      launchCoordinator: () => Promise.reject(new Error("Arc not stubbed")),
      timeline: () => Promise.resolve({ events: [], nextCursor: null }),
      draftFromSession: () => Promise.resolve({ name: null, brief: null }),
      promote: () => Promise.reject(new Error("Arc not stubbed")),
    },
    checkpoints: {
      list: () => Promise.resolve([]),
      previewRewind: () => Promise.reject(new Error("Checkpoint not stubbed")),
      rewindFiles: () => Promise.reject(new Error("Checkpoint not stubbed")),
    },
    review: {
      listChangedFiles,
      loadDiff,
      stageFile: () => Promise.resolve(),
      unstageFile: () => Promise.resolve(),
      revertFile: () => Promise.resolve(),
      stageHunk: () => Promise.resolve(),
      unstageHunk: () => Promise.resolve(),
      revertHunk: () => Promise.resolve(),
      commitStaged: () => Promise.resolve({ commitSha: "test", branch: "main", indexCleanupWarning: null, postCommitWarning: null })
    },
    workspace: {
      listFiles: (target) => target.kind === "project" ? listProjectFiles(target) : listWorkspaceFiles(target),
      readFile: (target, path) => target.kind === "project" ? readProjectFile(target, path) : readWorkspaceFile(target, path),
      writeFile: (target, path, content, mtime) => target.kind === "project"
        ? writeProjectFile(target, path, content, mtime)
        : Promise.resolve({ ok: "true", mtimeMs: 0, size: 0 } as const),
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
    connections: {
      list: connectionsList
    },
    settings: {
      agentTools: agentToolsStub,
      setBrowserTools: setBrowserToolsStub,
      previewChatCleanup: () => Promise.reject(new Error("Chat cleanup not stubbed")),
      deleteOldChats: () => Promise.reject(new Error("Chat cleanup not stubbed"))
    },
    system: {
      confirm: (message) => Promise.resolve(window.confirm(message)),
      openPath: () => Promise.resolve({ ok: true }),
      listDetectedIdes: listDetectedIdes,
      diagnostics: diagnosticsStub,
      debugSnapshot: () =>
        Promise.resolve({ generatedAt: "2026-05-14T11:00:05.000Z", ipcStats: [], logs: [] }),
      vacuumDatabase: vacuumDatabaseStub,
      setTheme: () => Promise.resolve({ ok: true }),
      setDefaultAgent: vi.fn(() => Promise.resolve({ ok: true }) as Promise<{ ok: true }>),
      setNotificationsEnabled: setNotificationsEnabledStub,
      setKeepAwake: setKeepAwakeStub,
      testNotification: testNotificationStub
    },
    remote: {
      getStatus: () => Promise.reject(new Error("remote status unavailable in tests")),
      setConfig: () => Promise.reject(new Error("remote config unavailable in tests")),
      testNotification: () => Promise.resolve({ ok: true }),
      setApnsConfig: () => Promise.reject(new Error("remote config unavailable in tests")),
      registerPushDevice: () => Promise.resolve([]),
      unregisterPushDevice: () => Promise.resolve([]),
      pushTest: () => Promise.resolve([]),
      pushCapability: () => Promise.resolve({ configured: false })
    },
    menu: {
      onCommand: (listener) => {
        menuCommandListener = listener;
        return () => {
          menuCommandListener = null;
        };
      }
    },
    sources: {
      list: () => Promise.resolve([]),
      add: () => Promise.reject(new Error("source writes not configured in this test")),
      update: () => Promise.reject(new Error("source writes not configured in this test")),
      delete: () => Promise.resolve()
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
      refresh: () => Promise.resolve([]),
      setPrimary: () => Promise.resolve([]),
      dismiss: () => Promise.resolve([])
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
      onExit: () => () => undefined,
      onAgentOpen: () => () => undefined
    },
    sync: {
      getStatus: vi.fn(() => Promise.resolve(syncStatusStub())),
      setConfig: vi.fn(() => Promise.resolve(syncStatusStub())),
      runNow: vi.fn(() => Promise.resolve(syncStatusStub()))
    },
    browser: {
      chromeProfiles: () => Promise.resolve([]),
      importChromeHistory: () => Promise.resolve({ entries: [], totalAvailable: 0 }),
      contentBlocking: () => Promise.resolve({ supported: false, disabledHosts: [] }),
      setSiteBlocking: () => Promise.resolve({ supported: false, disabledHosts: [] }),
      open: () => Promise.resolve({ ok: true }),
      navigate: () => Promise.resolve({ ok: true }),
      back: () => Promise.resolve({ ok: true }),
      forward: () => Promise.resolve({ ok: true }),
      reload: () => Promise.resolve({ ok: true }),
      setBounds: () => Promise.resolve({ ok: true }),
      focus: () => Promise.resolve({ ok: true }),
      extract: () => Promise.reject(new Error("browser.extract is not stubbed")),
      close: () => Promise.resolve({ ok: true }),
      stop: () => Promise.resolve({ ok: true }),
      setTheme: () => Promise.resolve({ ok: true }),
      fillCredentials: () => Promise.resolve({ ok: true, itemTitle: "Test Login" }),
      screenshot: () => Promise.resolve({ pngBase64: "", width: 0, height: 0 }),
      evaluate: () => Promise.resolve({ resultJson: "" }),
      listTabs: () => Promise.resolve({ tabs: [] }),
      openForSession: () => Promise.resolve({ tabId: "agent-1" }),
      snapshot: () =>
        Promise.resolve({
          tabId: "agent-1",
          url: "",
          title: "",
          state: "ready",
          tree: "",
          truncated: false
        }),
      find: () => Promise.resolve({ tabId: "agent-1", matches: [] }),
      getText: () =>
        Promise.resolve({
          tabId: "agent-1",
          url: "",
          title: "",
          state: "ready",
          text: "",
          truncated: false
        }),
      act: () => Promise.resolve({ tabId: "agent-1", url: "", detail: null }),
      onState: () => () => undefined,
      onNewTab: () => () => undefined,
      onPageCommand: () => () => undefined,
      onTabs: () => () => undefined,
      onAgentOpen: () => () => undefined
    }
  };
}

export function mockDashboardSnapshot(data: DashboardSnapshot): void {
  dashboardList.mockResolvedValue(dashboardListSnapshot(data));
  sessionEventsSince.mockResolvedValue(eventPageStub(data));
  sessionAgentEvents.mockResolvedValue(eventPageStub(data));
  approvalsPending.mockResolvedValue(data.approvals);
  workspaceStatus.mockResolvedValue(workspaceStatusSnapshot(data));
}

/** Settings owns the sidebar column, so the Argmax menu is only reachable with
 *  the page closed. Callers that re-open settings go back through here. */
export async function closeSettings(): Promise<void> {
  const rail = screen.queryByRole("complementary", { name: "Settings groups" });
  if (!rail) return;
  fireEvent.click(within(rail).getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Argmax menu" });
  await settle();
}

export async function openSettings(group: SettingsGroup = "General"): Promise<void> {
  await closeSettings();
  fireEvent.click(screen.getByRole("button", { name: "Argmax menu" }));
  const menu = await screen.findByRole("menu", { name: "Argmax menu" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Settings/ }));
  // Settings replaces the app sidebar with its own rail; the panel itself is
  // lazy, so wait for its page title rather than for the rail.
  const settingsGroups = await screen.findByRole("complementary", { name: "Settings groups" });
  await screen.findByRole("heading", { name: "General" });
  if (group === "General") return settle();

  fireEvent.click(within(settingsGroups).getByRole("button", { name: new RegExp(`^${group}$`) }));
  await screen.findByRole("heading", { name: group });
  if (group === "Advanced") {
    await screen.findByText("No learnings captured yet. Complete a session to start filling this list.");
  }
  await settle();
}

/**
 * The settings panels ask for their own status on mount (session sync, the
 * remote bridge). Those reads resolve a microtask after the click that opened
 * the panel, so every caller has to let them land inside `act` — otherwise
 * React reports the state they set as an update outside the test.
 */
async function settle(): Promise<void> {
  await act(async () => {});
}
