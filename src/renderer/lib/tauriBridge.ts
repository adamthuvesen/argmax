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
  SessionAgentEventsInput,
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
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";

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

function invokeCommand<T>(channel: IpcChannel, input: unknown = {}): Promise<T> {
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
    logger.error("renderer.bridge", "failed to subscribe to channel", {
      channel,
      error: errorMessage(error)
    });
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
      load: () => invokeCommand<DashboardSnapshot>("dashboard:load"),
      list: () => invokeCommand<DashboardListSnapshot>("dashboard:list"),
      onDelta: (listener: (delta: DashboardDelta) => void) =>
        subscribe<DashboardDelta>("dashboard:delta", listener)
    },
    projects: {
      list: () => invokeCommand<ProjectSummary[]>("projects:list"),
      pickFolder: () => invokeCommand<ProjectFolderPickResult>("projects:pick-folder"),
      register: (input: RegisterProjectInput) => invokeCommand<ProjectSummary>("projects:register", input),
      remove: (input: RemoveProjectInput) => invokeCommand<void>("projects:remove", input),
      updateSettings: (input: UpdateProjectSettingsInput) =>
        invokeCommand<ProjectSummary>("projects:update-settings", input),
      listBranches: (projectId: string) =>
        invokeCommand<string[]>("projects:list-branches", { projectId }),
      refreshBranch: (projectId: string) =>
        invokeCommand<ProjectSummary>("projects:refresh-branch", { projectId }),
      switchBranch: (projectId: string, branch: string) =>
        invokeCommand<ProjectSummary>("projects:switch-branch", { projectId, branch })
    },
    workspaces: {
      createIsolated: (input) => invokeCommand<WorkspaceSummary>("workspaces:create-isolated", input),
      createCurrent: (input) => invokeCommand<WorkspaceSummary>("workspaces:create-current", input),
      refreshStatus: (workspaceId) =>
        invokeCommand<WorkspaceSummary>("workspaces:refresh-status", { workspaceId }),
      status: (input: WorkspaceStatusInput = { workspaceIds: null }) =>
        invokeCommand<WorkspaceStatusSnapshot>("workspace:status", input),
      keep: (workspaceId) => invokeCommand<WorkspaceSummary>("workspaces:keep", { workspaceId }),
      archive: (input) => invokeCommand<WorkspaceSummary>("workspaces:archive", input),
      openInIde: (input: OpenInIdeInput) => invokeCommand<{ ok: true }>("workspaces:open-in-ide", input),
      autoTitle: (input) => invokeCommand<{ ok: true }>("workspaces:autotitle", input),
      setPinned: (input) => invokeCommand<WorkspaceSummary>("workspaces:set-pinned", input),
      setLabel: (input) => invokeCommand<WorkspaceSummary>("workspaces:set-label", input)
    },
    providers: {
      discover: (refresh = false) =>
        invokeCommand<DiscoveredProvider[]>("providers:discover", { refresh }),
      launch: (input: LaunchProviderSessionInput) => invokeCommand<SessionSummary>("providers:launch", input),
      sendInput: (input: ProviderSessionInput) =>
        invokeCommand<{ ok: true; queued: boolean }>("providers:send-input", input),
      resize: (input: ProviderSessionResizeInput) => invokeCommand<{ ok: true }>("providers:resize", input),
      terminate: (sessionId: string) => invokeCommand<{ ok: true }>("providers:terminate", { sessionId }),
      cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) =>
        invokeCommand<{ ok: true }>("providers:cancel-queued-message", input)
    },
    attachments: {
      saveImage: (input: AttachmentSaveImageInput) =>
        invokeCommand<AttachmentSaveImageResult>("attachments:save-image", input)
    },
    approvals: {
      pending: () => invokeCommand<DashboardSnapshot["approvals"]>("approvals:pending"),
      resolve: (input: ResolveApprovalInput) =>
        invokeCommand<DashboardSnapshot["approvals"][number]>("approvals:resolve", input)
    },
    session: {
      eventsSince: (input: SessionEventsSinceInput) =>
        invokeCommand<SessionEventsSinceResult>("session:events-since", input),
      agentEvents: (input: SessionAgentEventsInput) =>
        invokeCommand<SessionEventsSinceResult>("session:agent-events", input),
      costSummary: (input: SessionCostSummaryInput) =>
        invokeCommand<SessionCostSummary>("session:cost-summary", input),
      search: (input) => invokeCommand<SessionSearchResult>("session:search", input)
    },
    review: {
      listChangedFiles: (workspaceId: string, comparison?: ReviewComparison) =>
        invokeCommand<ChangedFileSummary[]>("review:list-changed-files", { workspaceId, comparison }),
      loadDiff: (workspaceId: string, filePath?: string, comparison?: ReviewComparison) =>
        invokeCommand<WorkspaceDiff>("review:load-diff", { workspaceId, filePath, comparison }),
      listChangedFilesForProject: (projectId: string, comparison?: ReviewComparison) =>
        invokeCommand<ChangedFileSummary[]>("review:list-changed-files-for-project", { projectId, comparison }),
      loadDiffForProject: (projectId: string, filePath?: string, comparison?: ReviewComparison) =>
        invokeCommand<WorkspaceDiff>("review:load-diff-for-project", { projectId, filePath, comparison })
    },
    workspace: {
      listFiles: (workspaceId: string) =>
        invokeCommand<WorkspaceFileEntry[]>("workspace:list-files", { workspaceId }),
      readFile: (workspaceId: string, filePath: string) =>
        invokeCommand<WorkspaceFilePreview>("workspace:read-file", { workspaceId, filePath }),
      writeFile: (workspaceId: string, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeCommand<WorkspaceFileWriteResult>("workspace:write-file", {
          workspaceId,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFile: (workspaceId: string, filePath: string) =>
        invokeCommand<WorkspaceFileStat>("workspace:stat-file", { workspaceId, filePath }),
      listFilesForProject: (projectId: string) =>
        invokeCommand<WorkspaceFileEntry[]>("workspace:list-files-for-project", { projectId }),
      readFileForProject: (projectId: string, filePath: string) =>
        invokeCommand<WorkspaceFilePreview>("workspace:read-file-for-project", { projectId, filePath }),
      writeFileForProject: (projectId: string, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeCommand<WorkspaceFileWriteResult>("workspace:write-file-for-project", {
          projectId,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFileForProject: (projectId: string, filePath: string) =>
        invokeCommand<WorkspaceFileStat>("workspace:stat-file-for-project", { projectId, filePath }),
      grepContent: (input) => invokeCommand<WorkspaceContentSearchResult>("workspace:grep-content", input)
    },
    checks: {
      run: (input: RunCheckInput) => invokeCommand<CheckRun>("checks:run", input)
    },
    checkpoints: {
      create: (input) => invokeCommand<Checkpoint>("checkpoints:create", input)
    },
    health: {
      ping: () => invokeCommand<{ ok: true; timestamp: string }>("health:ping")
    },
    skills: {
      list: (input) => invokeCommand<SkillSummary[]>("skills:list", input)
    },
    system: {
      openPath: (input) => invokeCommand<{ ok: true }>("system:open-path", input),
      listDetectedIdes: () => invokeCommand<DetectedIde[]>("system:list-detected-ides"),
      diagnostics: () => invokeCommand<DiagnosticsReport>("system:diagnostics"),
      vacuumDatabase: () => invokeCommand<{ ok: true }>("system:vacuum-database"),
      setTheme: (mode) => invokeCommand<{ ok: true }>("system:set-theme", { mode })
    },
    mcp: {
      list: () => invokeCommand<McpClientListing[]>("mcp:list"),
      auth: {
        start: (input: McpAuthStartInput) => invokeCommand<{ sessionId: string }>("mcp:auth:start", input),
        write: (input: McpAuthWriteInput) => invokeCommand<{ ok: true }>("mcp:auth:write", input),
        resize: (input: McpAuthResizeInput) => invokeCommand<{ ok: true }>("mcp:auth:resize", input),
        terminate: (sessionId: string) => invokeCommand<{ ok: true }>("mcp:auth:terminate", { sessionId }),
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
      list: (input) => invokeCommand<Learning[]>("learnings:list", input),
      update: (input) => invokeCommand<Learning>("learnings:update", input),
      delete: (id: string) => invokeCommand<{ ok: true }>("learnings:delete", { id })
    },
    prs: {
      listForSession: (input) => invokeCommand<GhPrRecord[]>("prs:list-for-session", input),
      refresh: (input) => invokeCommand<GhPrRecord[]>("prs:refresh", input)
    },
    git: {
      commit: (input: GitCommitInput) => invokeCommand<GitCommitResult>("git:commit", input),
      push: (input: GitPushInput) => invokeCommand<GitPushResult>("git:push", input),
      createBranch: (input: GitCreateBranchInput) =>
        invokeCommand<GitCreateBranchResult>("git:create-branch", input),
      viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
        invokeCommand<GitViewOrCreatePrResult>("git:view-or-create-pr", input)
    },
    terminal: {
      spawn: (input: TerminalSpawnInput) => invokeCommand<{ terminalId: string }>("terminal:spawn", input),
      write: (input: TerminalWriteInput) => invokeCommand<{ ok: true }>("terminal:write", input),
      resize: (input: TerminalResizeInput) => invokeCommand<{ ok: true }>("terminal:resize", input),
      terminate: (terminalId: string) => invokeCommand<{ ok: true }>("terminal:terminate", { terminalId }),
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
