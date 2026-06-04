import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { IpcChannel } from "../../shared/ipcSchemas.js";
import type {
  ArgmaxApi,
  AttachmentSaveImageInput,
  AttachmentSaveImageResult,
  ChangedFileSummary,
  CheckRun,
  Checkpoint,
  DashboardDelta,
  DashboardListSnapshot,
  DashboardSnapshot,
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  GhPrRecord,
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitPushInput,
  GitPushResult,
  GitViewOrCreatePrInput,
  GitViewOrCreatePrResult,
  Learning,
  LaunchProviderSessionInput,
  McpAuthDataEvent,
  McpAuthExitEvent,
  McpAuthResizeInput,
  McpAuthStartInput,
  McpAuthWriteInput,
  McpClientListing,
  MenuCommand,
  OpenInIdeInput,
  ProjectFolderPickResult,
  ProjectSummary,
  ProviderSessionInput,
  ProviderSessionResizeInput,
  ProvidersCancelQueuedMessageInput,
  RegisterProjectInput,
  RemoveProjectInput,
  ResolveApprovalInput,
  ReviewComparison,
  RunCheckInput,
  SessionCostSummary,
  SessionCostSummaryInput,
  SessionEventsSinceInput,
  SessionEventsSinceResult,
  SessionSummary,
  SkillSummary,
  EventSubscription,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeInput,
  TerminalSpawnInput,
  TerminalWriteInput,
  UpdateProjectSettingsInput,
  WorkspaceContentSearchResult,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult,
  WorkspaceStatusInput,
  WorkspaceStatusSnapshot,
  WorkspaceSummary
} from "../../shared/types.js";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type SessionSearchResult = Array<{
  sessionId: string;
  eventId: string;
  snippet: string;
  rank: number;
}>;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function invokeLegacy<T>(channel: IpcChannel, input: unknown = {}): Promise<T> {
  return tauriInvoke<T>(channel, { input });
}

function subscribe<T>(channel: string, listener: (payload: T) => void): EventSubscription {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  const ready = tauriListen<T>(channel, (event) => listener(event.payload)).then((nextUnlisten) => {
    if (disposed) {
      nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
    });
  ready.catch((error: unknown) => {
    console.error(`failed to subscribe to ${channel}`, error);
  });

  const off = (): void => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
  const readyForConsumers = ready.then(() => undefined);
  readyForConsumers.catch(() => undefined);
  off.ready = readyForConsumers;
  return off;
}

function createTauriArgmaxApi(): ArgmaxApi {
  return {
    dashboard: {
      load: () => invokeLegacy<DashboardSnapshot>("dashboard:load"),
      list: () => invokeLegacy<DashboardListSnapshot>("dashboard:list"),
      onDelta: (listener: (delta: DashboardDelta) => void) =>
        subscribe<DashboardDelta>("dashboard:delta", listener)
    },
    projects: {
      list: () => invokeLegacy<ProjectSummary[]>("projects:list"),
      pickFolder: () => invokeLegacy<ProjectFolderPickResult>("projects:pick-folder"),
      register: (input: RegisterProjectInput) => invokeLegacy<ProjectSummary>("projects:register", input),
      remove: (input: RemoveProjectInput) => invokeLegacy<{ projectId: string }>("projects:remove", input),
      updateSettings: (input: UpdateProjectSettingsInput) =>
        invokeLegacy<ProjectSummary>("projects:update-settings", input),
      listBranches: (projectId: string) =>
        invokeLegacy<string[]>("projects:list-branches", { projectId }),
      refreshBranch: (projectId: string) =>
        invokeLegacy<ProjectSummary>("projects:refresh-branch", { projectId }),
      switchBranch: (projectId: string, branch: string) =>
        invokeLegacy<ProjectSummary>("projects:switch-branch", { projectId, branch })
    },
    workspaces: {
      createIsolated: (input) => invokeLegacy<WorkspaceSummary>("workspaces:create-isolated", input),
      createCurrent: (input) => invokeLegacy<WorkspaceSummary>("workspaces:create-current", input),
      refreshStatus: (workspaceId) =>
        invokeLegacy<WorkspaceSummary>("workspaces:refresh-status", { workspaceId }),
      status: (input: WorkspaceStatusInput = { workspaceIds: null }) =>
        invokeLegacy<WorkspaceStatusSnapshot>("workspace:status", input),
      keep: (workspaceId) => invokeLegacy<WorkspaceSummary>("workspaces:keep", { workspaceId }),
      archive: (input) => invokeLegacy<WorkspaceSummary>("workspaces:archive", input),
      openInIde: (input: OpenInIdeInput) => invokeLegacy<{ ok: true }>("workspaces:open-in-ide", input),
      setPinned: (input) => invokeLegacy<WorkspaceSummary>("workspaces:set-pinned", input)
    },
    providers: {
      discover: (refresh = false) =>
        invokeLegacy<DiscoveredProvider[]>("providers:discover", { refresh }),
      launch: (input: LaunchProviderSessionInput) => invokeLegacy<SessionSummary>("providers:launch", input),
      sendInput: (input: ProviderSessionInput) =>
        invokeLegacy<{ ok: true; queued: boolean }>("providers:send-input", input),
      resize: (input: ProviderSessionResizeInput) => invokeLegacy<{ ok: true }>("providers:resize", input),
      terminate: (sessionId: string) => invokeLegacy<{ ok: true }>("providers:terminate", { sessionId }),
      cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) =>
        invokeLegacy<{ ok: true }>("providers:cancel-queued-message", input)
    },
    attachments: {
      saveImage: (input: AttachmentSaveImageInput) =>
        invokeLegacy<AttachmentSaveImageResult>("attachments:save-image", input)
    },
    approvals: {
      pending: () => invokeLegacy<DashboardSnapshot["approvals"]>("approvals:pending"),
      resolve: (input: ResolveApprovalInput) =>
        invokeLegacy<DashboardSnapshot["approvals"][number]>("approvals:resolve", input)
    },
    session: {
      eventsSince: (input: SessionEventsSinceInput) =>
        invokeLegacy<SessionEventsSinceResult>("session:events-since", input),
      costSummary: (input: SessionCostSummaryInput) =>
        invokeLegacy<SessionCostSummary>("session:cost-summary", input),
      search: (input) => invokeLegacy<SessionSearchResult>("session:search", input)
    },
    review: {
      listChangedFiles: (workspaceId: string, comparison?: ReviewComparison) =>
        invokeLegacy<ChangedFileSummary[]>("review:list-changed-files", { workspaceId, comparison }),
      loadDiff: (workspaceId: string, filePath?: string, comparison?: ReviewComparison) =>
        invokeLegacy<WorkspaceDiff>("review:load-diff", { workspaceId, filePath, comparison }),
      listChangedFilesForProject: (projectId: string, comparison?: ReviewComparison) =>
        invokeLegacy<ChangedFileSummary[]>("review:list-changed-files-for-project", { projectId, comparison }),
      loadDiffForProject: (projectId: string, filePath?: string, comparison?: ReviewComparison) =>
        invokeLegacy<WorkspaceDiff>("review:load-diff-for-project", { projectId, filePath, comparison })
    },
    workspace: {
      listFiles: (workspaceId: string) =>
        invokeLegacy<WorkspaceFileEntry[]>("workspace:list-files", { workspaceId }),
      readFile: (workspaceId: string, filePath: string) =>
        invokeLegacy<WorkspaceFilePreview>("workspace:read-file", { workspaceId, filePath }),
      writeFile: (workspaceId: string, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeLegacy<WorkspaceFileWriteResult>("workspace:write-file", {
          workspaceId,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFile: (workspaceId: string, filePath: string) =>
        invokeLegacy<WorkspaceFileStat>("workspace:stat-file", { workspaceId, filePath }),
      listFilesForProject: (projectId: string) =>
        invokeLegacy<WorkspaceFileEntry[]>("workspace:list-files-for-project", { projectId }),
      readFileForProject: (projectId: string, filePath: string) =>
        invokeLegacy<WorkspaceFilePreview>("workspace:read-file-for-project", { projectId, filePath }),
      writeFileForProject: (projectId: string, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeLegacy<WorkspaceFileWriteResult>("workspace:write-file-for-project", {
          projectId,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFileForProject: (projectId: string, filePath: string) =>
        invokeLegacy<WorkspaceFileStat>("workspace:stat-file-for-project", { projectId, filePath }),
      grepContent: (input) => invokeLegacy<WorkspaceContentSearchResult>("workspace:grep-content", input)
    },
    checks: {
      run: (input: RunCheckInput) => invokeLegacy<CheckRun>("checks:run", input)
    },
    checkpoints: {
      create: (input) => invokeLegacy<Checkpoint>("checkpoints:create", input)
    },
    health: {
      ping: () => invokeLegacy<{ ok: true; timestamp: string }>("health:ping")
    },
    skills: {
      list: (input) => invokeLegacy<SkillSummary[]>("skills:list", input)
    },
    system: {
      openPath: (input) => invokeLegacy<{ ok: true }>("system:open-path", input),
      listDetectedIdes: () => invokeLegacy<DetectedIde[]>("system:list-detected-ides"),
      diagnostics: () => invokeLegacy<DiagnosticsReport>("system:diagnostics"),
      vacuumDatabase: () => invokeLegacy<{ ok: true }>("system:vacuum-database"),
      setTheme: (mode) => invokeLegacy<{ ok: true }>("system:set-theme", { mode })
    },
    mcp: {
      list: () => invokeLegacy<McpClientListing[]>("mcp:list"),
      auth: {
        start: (input: McpAuthStartInput) => invokeLegacy<{ sessionId: string }>("mcp:auth:start", input),
        write: (input: McpAuthWriteInput) => invokeLegacy<{ ok: true }>("mcp:auth:write", input),
        resize: (input: McpAuthResizeInput) => invokeLegacy<{ ok: true }>("mcp:auth:resize", input),
        terminate: (sessionId: string) => invokeLegacy<{ ok: true }>("mcp:auth:terminate", { sessionId }),
        onData: (listener: (event: McpAuthDataEvent) => void) =>
          subscribe<McpAuthDataEvent>("mcp:auth:data", listener),
        onExit: (listener: (event: McpAuthExitEvent) => void) =>
          subscribe<McpAuthExitEvent>("mcp:auth:exit", listener)
      }
    },
    menu: {
      onCommand: (listener) => subscribe<MenuCommand>("menu:command", listener)
    },
    learnings: {
      list: (input) => invokeLegacy<Learning[]>("learnings:list", input),
      update: (input) => invokeLegacy<Learning>("learnings:update", input),
      delete: (id: string) => invokeLegacy<{ ok: true }>("learnings:delete", { id })
    },
    prs: {
      listForSession: (input) => invokeLegacy<GhPrRecord[]>("prs:list-for-session", input),
      refresh: (input) => invokeLegacy<GhPrRecord[]>("prs:refresh", input)
    },
    git: {
      commit: (input: GitCommitInput) => invokeLegacy<GitCommitResult>("git:commit", input),
      push: (input: GitPushInput) => invokeLegacy<GitPushResult>("git:push", input),
      createBranch: (input: GitCreateBranchInput) =>
        invokeLegacy<GitCreateBranchResult>("git:create-branch", input),
      viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
        invokeLegacy<GitViewOrCreatePrResult>("git:view-or-create-pr", input)
    },
    terminal: {
      spawn: (input: TerminalSpawnInput) => invokeLegacy<{ terminalId: string }>("terminal:spawn", input),
      write: (input: TerminalWriteInput) => invokeLegacy<{ ok: true }>("terminal:write", input),
      resize: (input: TerminalResizeInput) => invokeLegacy<{ ok: true }>("terminal:resize", input),
      terminate: (terminalId: string) => invokeLegacy<{ ok: true }>("terminal:terminate", { terminalId }),
      onData: (listener: (event: TerminalDataEvent) => void) =>
        subscribe<TerminalDataEvent>("terminal:data", listener),
      onExit: (listener: (event: TerminalExitEvent) => void) =>
        subscribe<TerminalExitEvent>("terminal:exit", listener)
    }
  };
}

export function installTauriBridge(): void {
  if (!isTauriRuntime() || window.argmax) {
    return;
  }
  window.argmax = createTauriArgmaxApi();
}

installTauriBridge();
