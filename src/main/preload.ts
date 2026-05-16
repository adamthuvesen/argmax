import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
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
  ProviderSessionResizeInput,
  ProjectFolderPickResult,
  ProjectSummary,
  RegisterProjectInput,
  ResolveApprovalInput,
  RunCheckInput,
  SelectPreferredAttemptInput,
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
  UpdateProjectSettingsInput,
  Tournament,
  TournamentLaunchInput,
  TournamentLeaderboard,
  ScoringPolicy
} from "../shared/types.js";

const api: ArgmaxApi = {
  dashboard: {
    load: () => ipcRenderer.invoke("dashboard:load") as Promise<DashboardSnapshot>,
    list: () => ipcRenderer.invoke("dashboard:list") as Promise<DashboardListSnapshot>,
    onDelta: (listener: (delta: DashboardDelta) => void) => {
      const handler = (_event: IpcRendererEvent, delta: DashboardDelta): void => listener(delta);
      ipcRenderer.on("dashboard:delta", handler);
      return () => ipcRenderer.removeListener("dashboard:delta", handler);
    }
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list") as Promise<ProjectSummary[]>,
    pickFolder: () => ipcRenderer.invoke("projects:pick-folder") as Promise<ProjectFolderPickResult>,
    register: (input: RegisterProjectInput) => ipcRenderer.invoke("projects:register", input) as Promise<ProjectSummary>,
    updateSettings: (input: UpdateProjectSettingsInput) =>
      ipcRenderer.invoke("projects:update-settings", input) as Promise<ProjectSummary>,
    listBranches: (projectId: string) =>
      ipcRenderer.invoke("projects:list-branches", { projectId }) as Promise<string[]>,
    switchBranch: (projectId: string, branch: string) =>
      ipcRenderer.invoke("projects:switch-branch", { projectId, branch }) as Promise<ProjectSummary>
  },
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) =>
      ipcRenderer.invoke("workspaces:create-isolated", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    createCurrent: (input: CreateCurrentWorkspaceInput) =>
      ipcRenderer.invoke("workspaces:create-current", input) as Promise<DashboardSnapshot["workspaces"][number]>,
    refreshStatus: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:refresh-status", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    status: (input?: WorkspaceStatusInput) =>
      ipcRenderer.invoke("workspace:status", input) as Promise<WorkspaceStatusSnapshot>,
    keep: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:keep", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    archive: (workspaceId: string) =>
      ipcRenderer.invoke("workspaces:archive", workspaceId) as Promise<DashboardSnapshot["workspaces"][number]>,
    openInIde: (input: OpenInIdeInput) =>
      ipcRenderer.invoke("workspaces:openInIde", input) as Promise<{ ok: true }>,
    setPinned: (input: { workspaceId: string; pinned: boolean }) =>
      ipcRenderer.invoke("workspaces:set-pinned", input) as Promise<DashboardSnapshot["workspaces"][number]>
  },
  providers: {
    discover: () => ipcRenderer.invoke("providers:discover") as Promise<DiscoveredProvider[]>,
    launch: (input: LaunchProviderSessionInput) =>
      ipcRenderer.invoke("providers:launch", input) as Promise<DashboardSnapshot["sessions"][number]>,
    sendInput: (input: ProviderSessionInput) =>
      ipcRenderer.invoke("providers:send-input", input) as Promise<{ ok: true }>,
    resize: (input: ProviderSessionResizeInput) =>
      ipcRenderer.invoke("providers:resize", input) as Promise<{ ok: true }>,
    terminate: (sessionId: string) => ipcRenderer.invoke("providers:terminate", sessionId) as Promise<{ ok: true }>
  },
  attachments: {
    saveImage: (input: AttachmentSaveImageInput) =>
      ipcRenderer.invoke("attachments:save-image", input) as Promise<AttachmentSaveImageResult>
  },
  approvals: {
    pending: () => ipcRenderer.invoke("approvals:pending") as Promise<DashboardSnapshot["approvals"]>,
    resolve: (input: ResolveApprovalInput) =>
      ipcRenderer.invoke("approvals:resolve", input) as Promise<DashboardSnapshot["approvals"][number]>
  },
  session: {
    eventsSince: (input: SessionEventsSinceInput) =>
      ipcRenderer.invoke("session:eventsSince", input) as Promise<SessionEventsSinceResult>,
    costSummary: (input: SessionCostSummaryInput) =>
      ipcRenderer.invoke("session:costSummary", input) as Promise<SessionCostSummary>,
    search: (input: { query: string; limit?: number }) =>
      ipcRenderer.invoke("session:search", input) as Promise<Array<{
        sessionId: string;
        eventId: string;
        snippet: string;
        rank: number;
      }>>
  },
  review: {
    listChangedFiles: (workspaceId: string) =>
      ipcRenderer.invoke("review:list-changed-files", workspaceId) as Promise<ChangedFileSummary[]>,
    loadDiff: (workspaceId: string, filePath?: string) =>
      ipcRenderer.invoke("review:load-diff", workspaceId, filePath) as Promise<WorkspaceDiff>,
    listChangedFilesForProject: (projectId: string) =>
      ipcRenderer.invoke("review:list-changed-files-for-project", projectId) as Promise<ChangedFileSummary[]>,
    loadDiffForProject: (projectId: string, filePath?: string) =>
      ipcRenderer.invoke("review:load-diff-for-project", projectId, filePath) as Promise<WorkspaceDiff>
  },
  workspace: {
    listFiles: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:list-files", { workspaceId }) as Promise<WorkspaceFileEntry[]>,
    readFile: (workspaceId: string, filePath: string) =>
      ipcRenderer.invoke("workspace:read-file", { workspaceId, filePath }) as Promise<WorkspaceFilePreview>,
    writeFile: (
      workspaceId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) =>
      ipcRenderer.invoke("workspace:write-file", {
        workspaceId,
        filePath,
        content,
        expectedMtimeMs
      }) as Promise<WorkspaceFileWriteResult>,
    statFile: (workspaceId: string, filePath: string) =>
      ipcRenderer.invoke("workspace:stat-file", { workspaceId, filePath }) as Promise<WorkspaceFileStat>,
    listFilesForProject: (projectId: string) =>
      ipcRenderer.invoke("workspace:list-files-for-project", { projectId }) as Promise<WorkspaceFileEntry[]>,
    readFileForProject: (projectId: string, filePath: string) =>
      ipcRenderer.invoke("workspace:read-file-for-project", { projectId, filePath }) as Promise<WorkspaceFilePreview>,
    writeFileForProject: (
      projectId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) =>
      ipcRenderer.invoke("workspace:write-file-for-project", {
        projectId,
        filePath,
        content,
        expectedMtimeMs
      }) as Promise<WorkspaceFileWriteResult>,
    statFileForProject: (projectId: string, filePath: string) =>
      ipcRenderer.invoke("workspace:stat-file-for-project", { projectId, filePath }) as Promise<WorkspaceFileStat>,
    grepContent: (input: { kind: "workspace" | "project"; id: string; query: string }) =>
      ipcRenderer.invoke("workspace:grep-content", input) as Promise<WorkspaceContentSearchResult>
  },
  checks: {
    run: (input: RunCheckInput) => ipcRenderer.invoke("checks:run", input) as Promise<DashboardSnapshot["checks"][number]>
  },
  checkpoints: {
    create: (input: CreateCheckpointInput) =>
      ipcRenderer.invoke("checkpoints:create", input) as Promise<DashboardSnapshot["checkpoints"][number]>
  },
  attempts: {
    selectPreferred: (input: SelectPreferredAttemptInput) =>
      ipcRenderer.invoke("attempts:select-preferred", input) as Promise<DashboardSnapshot["sessions"][number]>
  },
  health: {
    ping: () => ipcRenderer.invoke("health:ping") as Promise<{ ok: true; timestamp: string }>
  },
  skills: {
    list: (input: SkillsListInput) => ipcRenderer.invoke("skills:list", input) as Promise<SkillSummary[]>
  },
  system: {
    openPath: (input: { path: string; cwd?: string }) =>
      ipcRenderer.invoke("system:open-path", input) as Promise<{ ok: true }>,
    listDetectedIdes: () => ipcRenderer.invoke("system:listDetectedIdes") as Promise<DetectedIde[]>,
    diagnostics: () => ipcRenderer.invoke("system:diagnostics") as Promise<DiagnosticsReport>,
    vacuumDatabase: () => ipcRenderer.invoke("system:vacuumDatabase") as Promise<{ ok: true }>
  },
  mcp: {
    list: () => ipcRenderer.invoke("mcp:list") as Promise<McpClientListing[]>,
    auth: {
      start: (input: McpAuthStartInput) =>
        ipcRenderer.invoke("mcp:auth:start", input) as Promise<{ sessionId: string }>,
      write: (input: McpAuthWriteInput) =>
        ipcRenderer.invoke("mcp:auth:write", input) as Promise<{ ok: true }>,
      resize: (input: McpAuthResizeInput) =>
        ipcRenderer.invoke("mcp:auth:resize", input) as Promise<{ ok: true }>,
      terminate: (sessionId: string) =>
        ipcRenderer.invoke("mcp:auth:terminate", sessionId) as Promise<{ ok: true }>,
      onData: (listener: (event: McpAuthDataEvent) => void) => {
        const handler = (_event: IpcRendererEvent, payload: McpAuthDataEvent): void => listener(payload);
        ipcRenderer.on("mcp:auth:data", handler);
        return () => ipcRenderer.removeListener("mcp:auth:data", handler);
      },
      onExit: (listener: (event: McpAuthExitEvent) => void) => {
        const handler = (_event: IpcRendererEvent, payload: McpAuthExitEvent): void => listener(payload);
        ipcRenderer.on("mcp:auth:exit", handler);
        return () => ipcRenderer.removeListener("mcp:auth:exit", handler);
      }
    }
  },
  menu: {
    onCommand: (listener: (command: MenuCommand) => void) => {
      const handler = (_event: IpcRendererEvent, command: MenuCommand): void => listener(command);
      ipcRenderer.on("menu:command", handler);
      return () => ipcRenderer.removeListener("menu:command", handler);
    }
  },
  learnings: {
    list: (input: { projectId: string; limit?: number }) =>
      ipcRenderer.invoke("learnings:list", input) as Promise<Learning[]>,
    update: (input: { id: string; summary?: string; verified?: boolean }) =>
      ipcRenderer.invoke("learnings:update", input) as Promise<Learning>,
    delete: (id: string) => ipcRenderer.invoke("learnings:delete", { id }) as Promise<{ ok: true }>
  },
  prs: {
    listForSession: (input: { sessionId: string }) =>
      ipcRenderer.invoke("prs:listForSession", input) as Promise<GhPrRecord[]>,
    refresh: (input: { sessionId: string }) => ipcRenderer.invoke("prs:refresh", input) as Promise<GhPrRecord[]>
  },
  git: {
    commit: (input: GitCommitInput) => ipcRenderer.invoke("git:commit", input) as Promise<GitCommitResult>,
    push: (input: GitPushInput) => ipcRenderer.invoke("git:push", input) as Promise<GitPushResult>,
    createBranch: (input: GitCreateBranchInput) =>
      ipcRenderer.invoke("git:createBranch", input) as Promise<GitCreateBranchResult>,
    viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
      ipcRenderer.invoke("git:viewOrCreatePr", input) as Promise<GitViewOrCreatePrResult>
  },
  terminal: {
    spawn: (input: TerminalSpawnInput) =>
      ipcRenderer.invoke("terminal:spawn", input) as Promise<{ terminalId: string }>,
    write: (input: TerminalWriteInput) =>
      ipcRenderer.invoke("terminal:write", input) as Promise<{ ok: true }>,
    resize: (input: TerminalResizeInput) =>
      ipcRenderer.invoke("terminal:resize", input) as Promise<{ ok: true }>,
    terminate: (terminalId: string) =>
      ipcRenderer.invoke("terminal:terminate", terminalId) as Promise<{ ok: true }>,
    onData: (listener: (event: TerminalDataEvent) => void) => {
      const handler = (_event: IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.removeListener("terminal:data", handler);
    },
    onExit: (listener: (event: TerminalExitEvent) => void) => {
      const handler = (_event: IpcRendererEvent, payload: TerminalExitEvent): void => listener(payload);
      ipcRenderer.on("terminal:exit", handler);
      return () => ipcRenderer.removeListener("terminal:exit", handler);
    }
  },
  tournaments: {
    launch: (input: TournamentLaunchInput) =>
      ipcRenderer.invoke("tournament:launch", input) as Promise<Tournament>,
    list: (input: { projectId: string }) =>
      ipcRenderer.invoke("tournament:list", input) as Promise<Tournament[]>,
    get: (input: { tournamentId: string }) =>
      ipcRenderer.invoke("tournament:get", input) as Promise<TournamentLeaderboard>,
    keep: (input: { tournamentId: string; contestantIndex: number; reason?: string }) =>
      ipcRenderer.invoke("tournament:keep", input) as Promise<TournamentLeaderboard>
  },
  scoring: {
    listPolicies: () => ipcRenderer.invoke("scoring:listPolicies") as Promise<ScoringPolicy[]>
  }
};

contextBridge.exposeInMainWorld("argmax", api);
