import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { IpcChannel } from "../shared/ipcSchemas.js";
import type {
  DashboardSnapshot,
  ChangedFileSummary,
  CreateCheckpointInput,
  CreateCurrentWorkspaceInput,
  CreateWorkspaceInput,
  DashboardDelta,
  DashboardListSnapshot,
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
  LaunchProviderSessionInput,
  Learning,
  McpAuthDataEvent,
  McpAuthExitEvent,
  McpAuthResizeInput,
  McpAuthStartInput,
  McpAuthWriteInput,
  McpClientListing,
  ArgmaxApi,
  AttachmentSaveImageInput,
  AttachmentSaveImageResult,
  MenuCommand,
  OpenInIdeInput,
  ProviderSessionInput,
  ProvidersCancelQueuedMessageInput,
  ProviderSessionResizeInput,
  ProjectFolderPickResult,
  ProjectSummary,
  RegisterProjectInput,
  RemoveProjectInput,
  ResolveApprovalInput,
  RunCheckInput,
  SessionCostSummary,
  SessionCostSummaryInput,
  SessionEventsSinceInput,
  SessionEventsSinceResult,
  SkillsListInput,
  SkillSummary,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeInput,
  TerminalSpawnInput,
  TerminalWriteInput,
  WorkspaceContentSearchResult,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult,
  WorkspaceStatusInput,
  WorkspaceStatusSnapshot,
  UpdateProjectSettingsInput
} from "../shared/types.js";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * Single typed entry point for every `ipcRenderer.invoke`. The channel name
 * is constrained to the IpcChannel union (derived from ipcSchemas), so a
 * typo or stale channel name is a compile-time error instead of a silent
 * runtime "no handler registered" failure. Output narrowing is the caller's
 * responsibility (cast the returned `Promise<unknown>`) — the goal is one
 * audit point, not full output typing, until each channel gets an explicit
 * output schema. Migrate call sites from `ipcRenderer.invoke(...)` to this
 * helper as you touch them. (audit-2026-05-17 L8)
 */
function invoke<C extends IpcChannel>(channel: C, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: ArgmaxApi = {
  dashboard: {
    load: () => invoke("dashboard:load") as Promise<DashboardSnapshot>,
    list: () => invoke("dashboard:list") as Promise<DashboardListSnapshot>,
    onDelta: (listener: (delta: DashboardDelta) => void) =>
      subscribe<DashboardDelta>("dashboard:delta", listener)
  },
  projects: {
    list: () => invoke("projects:list") as Promise<ProjectSummary[]>,
    pickFolder: () => invoke("projects:pick-folder") as Promise<ProjectFolderPickResult>,
    register: (input: RegisterProjectInput) => invoke("projects:register", input) as Promise<ProjectSummary>,
    remove: (input: RemoveProjectInput) =>
      invoke("projects:remove", input) as Promise<{ projectId: string }>,
    updateSettings: (input: UpdateProjectSettingsInput) =>
      invoke("projects:update-settings", input) as Promise<ProjectSummary>,
    listBranches: (projectId: string) =>
      invoke("projects:list-branches", { projectId }) as Promise<string[]>,
    switchBranch: (projectId: string, branch: string) =>
      invoke("projects:switch-branch", { projectId, branch }) as Promise<ProjectSummary>
  },
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) =>
      invoke("workspaces:create-isolated", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    createCurrent: (input: CreateCurrentWorkspaceInput) =>
      invoke("workspaces:create-current", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    refreshStatus: (workspaceId: string) =>
      invoke("workspaces:refresh-status", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    status: (input?: WorkspaceStatusInput) =>
      invoke("workspace:status", input) as Promise<WorkspaceStatusSnapshot>,
    keep: (workspaceId: string) =>
      invoke("workspaces:keep", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    archive: (input: { workspaceId: string; force?: boolean }) =>
      invoke("workspaces:archive", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    openInIde: (input: OpenInIdeInput) =>
      invoke("workspaces:open-in-ide", input) as Promise<{ ok: true }>,
    setPinned: (input: { workspaceId: string; pinned: boolean }) =>
      invoke("workspaces:set-pinned", input) as Promise<DashboardSnapshot["workspaces"][number]>
  },
  providers: {
    discover: () => invoke("providers:discover") as Promise<DiscoveredProvider[]>,
    launch: (input: LaunchProviderSessionInput) =>
      invoke("providers:launch", input) as Promise<DashboardSnapshot["sessions"][number]>,
    sendInput: (input: ProviderSessionInput) =>
      invoke("providers:send-input", input) as Promise<{ ok: true; queued: boolean }>,
    resize: (input: ProviderSessionResizeInput) =>
      invoke("providers:resize", input) as Promise<{ ok: true }>,
    terminate: (sessionId: string) => invoke("providers:terminate", sessionId) as Promise<{ ok: true }>,
    cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) =>
      invoke("providers:cancel-queued-message", input) as Promise<{ ok: true }>
  },
  attachments: {
    saveImage: (input: AttachmentSaveImageInput) =>
      invoke("attachments:save-image", input) as Promise<AttachmentSaveImageResult>
  },
  approvals: {
    pending: () => invoke("approvals:pending") as Promise<DashboardSnapshot["approvals"]>,
    resolve: (input: ResolveApprovalInput) =>
      invoke("approvals:resolve", input) as Promise<DashboardSnapshot["approvals"][number]>
  },
  session: {
    eventsSince: (input: SessionEventsSinceInput) =>
      invoke("session:events-since", input) as Promise<SessionEventsSinceResult>,
    costSummary: (input: SessionCostSummaryInput) =>
      invoke("session:cost-summary", input) as Promise<SessionCostSummary>,
    search: (input: { query: string; limit?: number }) =>
      invoke("session:search", input) as Promise<Array<{
        sessionId: string;
        eventId: string;
        snippet: string;
        rank: number;
      }>>
  },
  review: {
    listChangedFiles: (workspaceId: string) =>
      invoke("review:list-changed-files", workspaceId) as Promise<ChangedFileSummary[]>,
    loadDiff: (workspaceId: string, filePath?: string) =>
      invoke("review:load-diff", workspaceId, filePath) as Promise<WorkspaceDiff>,
    listChangedFilesForProject: (projectId: string) =>
      invoke("review:list-changed-files-for-project", projectId) as Promise<ChangedFileSummary[]>,
    loadDiffForProject: (projectId: string, filePath?: string) =>
      invoke("review:load-diff-for-project", projectId, filePath) as Promise<WorkspaceDiff>
  },
  workspace: {
    listFiles: (workspaceId: string) =>
      invoke("workspace:list-files", { workspaceId }) as Promise<WorkspaceFileEntry[]>,
    readFile: (workspaceId: string, filePath: string) =>
      invoke("workspace:read-file", { workspaceId, filePath }) as Promise<WorkspaceFilePreview>,
    writeFile: (
      workspaceId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) =>
      invoke("workspace:write-file", {
        workspaceId,
        filePath,
        content,
        expectedMtimeMs
      }) as Promise<WorkspaceFileWriteResult>,
    statFile: (workspaceId: string, filePath: string) =>
      invoke("workspace:stat-file", { workspaceId, filePath }) as Promise<WorkspaceFileStat>,
    listFilesForProject: (projectId: string) =>
      invoke("workspace:list-files-for-project", { projectId }) as Promise<WorkspaceFileEntry[]>,
    readFileForProject: (projectId: string, filePath: string) =>
      invoke("workspace:read-file-for-project", { projectId, filePath }) as Promise<WorkspaceFilePreview>,
    writeFileForProject: (
      projectId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) =>
      invoke("workspace:write-file-for-project", {
        projectId,
        filePath,
        content,
        expectedMtimeMs
      }) as Promise<WorkspaceFileWriteResult>,
    statFileForProject: (projectId: string, filePath: string) =>
      invoke("workspace:stat-file-for-project", { projectId, filePath }) as Promise<WorkspaceFileStat>,
    grepContent: (input: { kind: "workspace" | "project"; id: string; query: string }) =>
      invoke("workspace:grep-content", input) as Promise<WorkspaceContentSearchResult>
  },
  checks: {
    run: (input: RunCheckInput) => invoke("checks:run", input) as Promise<DashboardSnapshot["checks"][number]>
  },
  checkpoints: {
    create: (input: CreateCheckpointInput) =>
      invoke("checkpoints:create", input) as Promise<DashboardSnapshot["checkpoints"][number]>
  },
  health: {
    ping: () => invoke("health:ping") as Promise<{ ok: true; timestamp: string }>
  },
  skills: {
    list: (input: SkillsListInput) => invoke("skills:list", input) as Promise<SkillSummary[]>
  },
  system: {
    openPath: (input: { path: string; cwd?: string }) =>
      invoke("system:open-path", input) as Promise<{ ok: true }>,
    listDetectedIdes: () => invoke("system:list-detected-ides") as Promise<DetectedIde[]>,
    diagnostics: () => invoke("system:diagnostics") as Promise<DiagnosticsReport>,
    vacuumDatabase: () => invoke("system:vacuum-database") as Promise<{ ok: true }>,
    setTheme: (mode: "light" | "dark" | "system") =>
      invoke("system:set-theme", { mode }) as Promise<{ ok: true }>
  },
  mcp: {
    list: () => invoke("mcp:list") as Promise<McpClientListing[]>,
    auth: {
      start: (input: McpAuthStartInput) =>
        invoke("mcp:auth:start", input) as Promise<{ sessionId: string }>,
      write: (input: McpAuthWriteInput) =>
        invoke("mcp:auth:write", input) as Promise<{ ok: true }>,
      resize: (input: McpAuthResizeInput) =>
        invoke("mcp:auth:resize", input) as Promise<{ ok: true }>,
      terminate: (sessionId: string) =>
        invoke("mcp:auth:terminate", sessionId) as Promise<{ ok: true }>,
      onData: (listener: (event: McpAuthDataEvent) => void) =>
        subscribe<McpAuthDataEvent>("mcp:auth:data", listener),
      onExit: (listener: (event: McpAuthExitEvent) => void) =>
        subscribe<McpAuthExitEvent>("mcp:auth:exit", listener)
    }
  },
  menu: {
    onCommand: (listener: (command: MenuCommand) => void) =>
      subscribe<MenuCommand>("menu:command", listener)
  },
  learnings: {
    list: (input: { projectId: string; limit?: number }) =>
      invoke("learnings:list", input) as Promise<Learning[]>,
    update: (input: { id: string; summary?: string; verified?: boolean }) =>
      invoke("learnings:update", input) as Promise<Learning>,
    delete: (id: string) => invoke("learnings:delete", { id }) as Promise<{ ok: true }>
  },
  prs: {
    listForSession: (input: { sessionId: string }) =>
      invoke("prs:list-for-session", input) as Promise<GhPrRecord[]>,
    refresh: (input: { sessionId: string }) => invoke("prs:refresh", input) as Promise<GhPrRecord[]>
  },
  git: {
    commit: (input: GitCommitInput) => invoke("git:commit", input) as Promise<GitCommitResult>,
    push: (input: GitPushInput) => invoke("git:push", input) as Promise<GitPushResult>,
    createBranch: (input: GitCreateBranchInput) =>
      invoke("git:create-branch", input) as Promise<GitCreateBranchResult>,
    viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
      invoke("git:view-or-create-pr", input) as Promise<GitViewOrCreatePrResult>
  },
  terminal: {
    spawn: (input: TerminalSpawnInput) =>
      invoke("terminal:spawn", input) as Promise<{ terminalId: string }>,
    write: (input: TerminalWriteInput) =>
      invoke("terminal:write", input) as Promise<{ ok: true }>,
    resize: (input: TerminalResizeInput) =>
      invoke("terminal:resize", input) as Promise<{ ok: true }>,
    terminate: (terminalId: string) =>
      invoke("terminal:terminate", terminalId) as Promise<{ ok: true }>,
    onData: (listener: (event: TerminalDataEvent) => void) =>
      subscribe<TerminalDataEvent>("terminal:data", listener),
    onExit: (listener: (event: TerminalExitEvent) => void) =>
      subscribe<TerminalExitEvent>("terminal:exit", listener)
  }
};

contextBridge.exposeInMainWorld("argmax", api);
