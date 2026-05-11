import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DashboardSnapshot,
  ChangedFileSummary,
  CommitPreparation,
  CreateCheckpointInput,
  CreateCurrentWorkspaceInput,
  CreateWorkspaceInput,
  DashboardDelta,
  DashboardListSnapshot,
  DetectedIde,
  LaunchProviderSessionInput,
  ArgmaxApi,
  OpenInIdeInput,
  PrepareCommitInput,
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
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceStatusInput,
  WorkspaceStatusSnapshot,
  UpdateProjectSettingsInput
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
      ipcRenderer.invoke("workspaces:openInIde", input) as Promise<{ ok: true }>
  },
  providers: {
    discover: () => ipcRenderer.invoke("providers:discover") as Promise<unknown[]>,
    launch: (input: LaunchProviderSessionInput) =>
      ipcRenderer.invoke("providers:launch", input) as Promise<DashboardSnapshot["sessions"][number]>,
    sendInput: (input: ProviderSessionInput) =>
      ipcRenderer.invoke("providers:send-input", input) as Promise<{ ok: true }>,
    resize: (input: ProviderSessionResizeInput) =>
      ipcRenderer.invoke("providers:resize", input) as Promise<{ ok: true }>,
    terminate: (sessionId: string) => ipcRenderer.invoke("providers:terminate", sessionId) as Promise<{ ok: true }>
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
      ipcRenderer.invoke("session:costSummary", input) as Promise<SessionCostSummary>
  },
  review: {
    listChangedFiles: (workspaceId: string) =>
      ipcRenderer.invoke("review:list-changed-files", workspaceId) as Promise<ChangedFileSummary[]>,
    loadDiff: (workspaceId: string, filePath?: string) =>
      ipcRenderer.invoke("review:load-diff", workspaceId, filePath) as Promise<WorkspaceDiff>
  },
  workspace: {
    listFiles: (workspaceId: string) =>
      ipcRenderer.invoke("workspace:list-files", { workspaceId }) as Promise<WorkspaceFileEntry[]>,
    readFile: (workspaceId: string, filePath: string) =>
      ipcRenderer.invoke("workspace:read-file", { workspaceId, filePath }) as Promise<WorkspaceFilePreview>
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
  commits: {
    prepare: (input: PrepareCommitInput) => ipcRenderer.invoke("commits:prepare", input) as Promise<CommitPreparation>
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
    listDetectedIdes: () => ipcRenderer.invoke("system:listDetectedIdes") as Promise<DetectedIde[]>
  }
};

contextBridge.exposeInMainWorld("argmax", api);
