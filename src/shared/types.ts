/**
 * IPC-input types are inferred from the zod schemas in `./ipcSchemas.ts`
 * via `import type` so the renderer never pulls zod into its bundle. The
 * `import type` form erases at runtime; only the type signatures cross
 * this boundary.
 */
import type {
  AttachmentSaveImageResultParsed
} from "./ipcSchemas.js";
import type * as Bindings from "./bindings.js";
import type { UsageCounts } from "./providerModels.js";

// Backend-derived IPC and diagnostics types come from generated Rust bindings.
// `ArgmaxApi` and renderer-only domain shapes remain hand-written below.
export type AgentMode = Bindings.AgentMode;
export type AttachmentMimeType = Bindings.AttachmentMimeType;
export type DatabaseStats = Bindings.DatabaseStats;
export type DetectedIde = Bindings.DetectedIde;
export type DiagnosticsReport = Omit<Bindings.DiagnosticsReport, "recentLogs"> & {
  recentLogs: LogEntry[];
};
export type IdeId = Bindings.IdeId;
export type IpcChannelStats = Bindings.IpcChannelStats;
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  fields: Record<string, unknown>;
}
export type PermissionMode = Bindings.PermissionMode;
export type ProviderId = Bindings.ProviderId;
export type ReasoningEffort = Bindings.ReasoningEffort;
export type StartupPhaseRecord = Bindings.StartupPhaseRecord;
export type ProviderMode = "interactive-pty" | "structured-json";

export interface DiscoveredProvider {
  provider: ProviderId;
  displayName: string;
  binaryName: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  modes: ProviderMode[];
  setupGuidance: string | null;
}

export type WorkspaceState =
  | "created"
  | "running"
  | "waiting"
  | "blocked"
  | "complete"
  | "failed"
  | "cancelled"
  | "kept"
  | "archived";

export type SessionState = "created" | "running" | "waiting" | "blocked" | "complete" | "failed" | "cancelled";

export type AttentionState = "normal" | "approval-needed" | "blocked" | "failed" | "review-ready";

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export type EventType =
  | "session.started"
  | "user.message"
  | "message.delta"
  | "message.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "approval.requested"
  | "approval.resolved"
  | "file.changed"
  | "check.started"
  | "check.completed"
  | "error"
  | "session.completed"
  | "session.cancelled"
  | "session.recovered-from-crash";

export interface ProjectSettings {
  defaultProvider: ProviderId;
  defaultModelLabel: string;
  worktreeLocation: string;
  setupCommand: string;
  checkCommands: string[];
}

export type RegisterProjectInput = Bindings.ProjectsRegisterInput;
export type RemoveProjectInput = Bindings.ProjectsRemoveInput;
export type UpdateProjectSettingsInput = Bindings.ProjectsUpdateSettingsInput;
export type CreateWorkspaceInput = Bindings.WorkspacesCreateIsolatedInput;
export type CreateCurrentWorkspaceInput = Bindings.WorkspacesCreateCurrentInput;
type OptionalNullable<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: T[P];
};

export type LaunchProviderSessionInput = OptionalNullable<
  Bindings.ProvidersLaunchInput,
  "reasoningEffort" | "agentMode" | "permissionMode" | "attachments"
>;
export type ProviderSessionInput = OptionalNullable<
  Bindings.ProvidersSendInput,
  "modelLabel" | "modelId" | "reasoningEffort" | "agentMode" | "attachments"
>;
export type ProvidersCancelQueuedMessageInput = Bindings.ProvidersCancelQueuedMessageInput;
export type ProviderSessionResizeInput = Bindings.ProvidersResizeInput;
export type ComposerAttachment = Bindings.ComposerAttachmentInput;
export type AttachmentSaveImageInput = Bindings.AttachmentsSaveImageInput;
export type AttachmentSaveImageResult = AttachmentSaveImageResultParsed;
export type ResolveApprovalInput = Bindings.ApprovalsResolveInput;
export type SessionEventsSinceInput = OptionalNullable<
  Bindings.SessionEventsSinceInput,
  "eventCursor" | "rawOutputCursor"
>;
export type SessionCostSummaryInput = Bindings.SessionCostSummaryInput;
export type WorkspaceStatusInput = OptionalNullable<Bindings.WorkspaceStatusInput, "workspaceIds">;
export type TerminalSpawnInput = Bindings.TerminalSpawnInput;
export type TerminalWriteInput = Bindings.TerminalWriteInput;
export type TerminalResizeInput = Bindings.TerminalResizeInput;
export type McpAuthStartInput = Bindings.McpAuthStartInput;
export type McpAuthWriteInput = Bindings.McpAuthWriteInput;
export type McpAuthResizeInput = Bindings.McpAuthResizeInput;

export interface TerminalDataEvent {
  terminalId: string;
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number;
  signal: number | null;
}

export interface McpAuthDataEvent {
  sessionId: string;
  data: string;
}

export interface McpAuthExitEvent {
  sessionId: string;
  exitCode: number;
  signal: number | null;
}

export interface SessionCostSummary {
  sessionId: string;
  modelId: string | null;
  tokens: UsageCounts;
  costUsd: number;
}

export interface ChangedFileSummary {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface WorkspaceDiff {
  workspaceId: string;
  filePath: string | null;
  content: string;
}

export interface WorkspaceFileEntry {
  path: string;
}

export type WorkspaceFilePreview =
  | { kind: "text"; content: string; size: number; mtimeMs: number }
  | { kind: "skipped"; reason: "binary" | "too-large" | "not-a-file"; size?: number };

export interface WorkspaceFileStat {
  mtimeMs: number;
  size: number;
}

/**
 * Result of `workspace:grep-content`. `truncated` is true when the backend
 * stopped enumerating matches because the result cap was reached — informs
 * the renderer to surface "showing first N of many" copy.
 */
export interface WorkspaceContentSearchMatch {
  line: number;
  preview: string;
}

export interface WorkspaceContentSearchFile {
  path: string;
  matches: WorkspaceContentSearchMatch[];
}

export interface WorkspaceContentSearchResult {
  files: WorkspaceContentSearchFile[];
  truncated: boolean;
}

/**
 * Result of `workspace:writeFile`. `ok: false, reason: "stale"` means the file
 * on disk was mutated since the editor last observed it; the renderer should
 * surface the "changed on disk, reload?" banner with `currentMtimeMs` as the
 * new baseline if the user chooses to keep their edits.
 */
export type WorkspaceFileWriteResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; reason: "stale"; currentMtimeMs: number; size: number };

export type RunCheckInput = Bindings.ChecksRunInput;
export type CreateCheckpointInput = Bindings.CheckpointsCreateInput;
export type GitCommitInput = OptionalNullable<Bindings.GitCommitInput, "selectedFiles">;
export type GitPushInput = Bindings.GitPushInput;
export type GitCreateBranchInput = Bindings.GitCreateBranchInput;
export type GitViewOrCreatePrInput = Bindings.GitViewOrCreatePrInput;

export interface GitCommitResult {
  commitSha: string;
  branch: string;
}

export interface GitPushResult {
  branch: string;
  upstreamSet: boolean;
}

export interface GitCreateBranchResult {
  branch: string;
}

export type GitViewOrCreatePrResult =
  | { action: "opened"; url: string; prNumber: number }
  | { action: "created"; url: string; prNumber: number | null };
export type SkillsListInput = OptionalNullable<Bindings.SkillsListInput, "workspaceId">;
export type OpenInIdeInput = Bindings.WorkspacesOpenInIdeInput;

export type SkillSource = "user" | "workspace" | "codex-prompt" | "plugin" | "system";

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
}

export interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  currentBranch: string;
  defaultBranch: string | null;
  settings: ProjectSettings;
  counts: {
    active: number;
    blocked: number;
    failed: number;
    reviewReady: number;
  };
  latestActivityAt: string | null;
}

export type ProjectFolderPickResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      project: ProjectSummary;
    };

export interface WorkspaceSummary {
  id: string;
  projectId: string;
  taskLabel: string;
  branch: string;
  baseRef: string;
  path: string;
  state: WorkspaceState;
  sharedWorkspace: boolean;
  dirty: boolean;
  changedFiles: number;
  lastActivityAt: string;
  pinned: boolean;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode: PermissionMode;
  agentMode?: AgentMode;
  providerConversationId: string | null;
  prompt: string;
  state: SessionState;
  attention: AttentionState;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  costUsd?: number;
  tokens?: UsageCounts;
}

/**
 * A user-composed follow-up that arrived while the agent was mid-turn. Held in
 * the main-process queue (in-memory only) until the session reaches `complete`,
 * at which point items drain one-at-a-time as fresh follow-up turns.
 */
export interface PendingMessage {
  id: string;
  sessionId: string;
  content: string;
  agentMode: AgentMode;
  modelLabel?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  attachments?: ComposerAttachment[];
  queuedAt: string;
}

export interface TimelineEvent {
  id: string;
  sessionId: string;
  type: EventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
  rowCursor?: number;
}

export interface RawProviderOutput {
  id: string;
  sessionId: string;
  stream: "stdout" | "stderr" | "pty" | "system";
  content: string;
  createdAt: string;
  rowCursor?: number;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  provider: ProviderId;
  riskLevel: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
}

export interface CheckRun {
  id: string;
  workspaceId: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface Checkpoint {
  id: string;
  workspaceId: string;
  label: string;
  branch: string;
  gitRef: string | null;
  patchPath: string | null;
  createdAt: string;
}

export interface DashboardSnapshot {
  projects: ProjectSummary[];
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  approvals: ApprovalRequest[];
  checks: CheckRun[];
  checkpoints: Checkpoint[];
  /**
   * Per-session queue of follow-ups composed while the agent was running.
   * Full replacement per session id (an empty array clears that session's queue).
   * Omitted on snapshots that pre-date the feature; absent keys mean "no change."
   */
  pendingMessages?: Record<string, PendingMessage[]>;
}

export type DashboardListSnapshot = Pick<
  DashboardSnapshot,
  "projects" | "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export type WorkspaceStatusSnapshot = Pick<
  DashboardSnapshot,
  "workspaces" | "sessions" | "checks" | "checkpoints"
>;

export interface SessionEventsSinceResult {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  eventCursor: number;
  rawOutputCursor: number;
}

export type DashboardDelta = {
  [K in keyof DashboardSnapshot]?: DashboardSnapshot[K];
};

export interface ArgmaxApi {
  dashboard: {
    load: () => Promise<DashboardSnapshot>;
    list: () => Promise<DashboardListSnapshot>;
    onDelta: (listener: (delta: DashboardDelta) => void) => () => void;
  };
  projects: {
    list: () => Promise<ProjectSummary[]>;
    pickFolder: () => Promise<ProjectFolderPickResult>;
    register: (input: RegisterProjectInput) => Promise<ProjectSummary>;
    remove: (input: RemoveProjectInput) => Promise<{ projectId: string }>;
    updateSettings: (input: UpdateProjectSettingsInput) => Promise<ProjectSummary>;
    listBranches: (projectId: string) => Promise<string[]>;
    switchBranch: (projectId: string, branch: string) => Promise<ProjectSummary>;
  };
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) => Promise<WorkspaceSummary>;
    createCurrent: (input: CreateCurrentWorkspaceInput) => Promise<WorkspaceSummary>;
    refreshStatus: (workspaceId: string) => Promise<WorkspaceSummary>;
    status: (input?: WorkspaceStatusInput) => Promise<WorkspaceStatusSnapshot>;
    keep: (workspaceId: string) => Promise<WorkspaceSummary>;
    archive: (input: { workspaceId: string; force?: boolean }) => Promise<WorkspaceSummary>;
    openInIde: (input: OpenInIdeInput) => Promise<{ ok: true }>;
    setPinned: (input: { workspaceId: string; pinned: boolean }) => Promise<WorkspaceSummary>;
  };
  providers: {
    discover: () => Promise<DiscoveredProvider[]>;
    launch: (input: LaunchProviderSessionInput) => Promise<SessionSummary>;
    sendInput: (input: ProviderSessionInput) => Promise<{ ok: true; queued: boolean }>;
    resize: (input: ProviderSessionResizeInput) => Promise<{ ok: true }>;
    terminate: (sessionId: string) => Promise<{ ok: true }>;
    cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) => Promise<{ ok: true }>;
  };
  attachments: {
    saveImage: (input: AttachmentSaveImageInput) => Promise<AttachmentSaveImageResult>;
  };
  approvals: {
    pending: () => Promise<ApprovalRequest[]>;
    resolve: (input: ResolveApprovalInput) => Promise<ApprovalRequest>;
  };
  session: {
    eventsSince: (input: SessionEventsSinceInput) => Promise<SessionEventsSinceResult>;
    costSummary: (input: SessionCostSummaryInput) => Promise<SessionCostSummary>;
    search: (input: { query: string; limit?: number }) => Promise<Array<{
      sessionId: string;
      eventId: string;
      snippet: string;
      rank: number;
    }>>;
  };
  review: {
    listChangedFiles: (workspaceId: string) => Promise<ChangedFileSummary[]>;
    loadDiff: (workspaceId: string, filePath?: string) => Promise<WorkspaceDiff>;
    listChangedFilesForProject: (projectId: string) => Promise<ChangedFileSummary[]>;
    loadDiffForProject: (projectId: string, filePath?: string) => Promise<WorkspaceDiff>;
  };
  workspace: {
    listFiles: (workspaceId: string) => Promise<WorkspaceFileEntry[]>;
    readFile: (workspaceId: string, filePath: string) => Promise<WorkspaceFilePreview>;
    writeFile: (
      workspaceId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) => Promise<WorkspaceFileWriteResult>;
    statFile: (workspaceId: string, filePath: string) => Promise<WorkspaceFileStat>;
    listFilesForProject: (projectId: string) => Promise<WorkspaceFileEntry[]>;
    readFileForProject: (projectId: string, filePath: string) => Promise<WorkspaceFilePreview>;
    writeFileForProject: (
      projectId: string,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) => Promise<WorkspaceFileWriteResult>;
    statFileForProject: (projectId: string, filePath: string) => Promise<WorkspaceFileStat>;
    grepContent: (input: {
      kind: "workspace" | "project";
      id: string;
      query: string;
    }) => Promise<WorkspaceContentSearchResult>;
  };
  checks: {
    run: (input: RunCheckInput) => Promise<CheckRun>;
  };
  checkpoints: {
    create: (input: CreateCheckpointInput) => Promise<Checkpoint>;
  };
  health: {
    ping: () => Promise<{ ok: true; timestamp: string }>;
  };
  skills: {
    list: (input: SkillsListInput) => Promise<SkillSummary[]>;
  };
  system: {
    openPath: (input: { path: string; cwd?: string }) => Promise<{ ok: true }>;
    listDetectedIdes: () => Promise<DetectedIde[]>;
    diagnostics: () => Promise<DiagnosticsReport>;
    vacuumDatabase: () => Promise<{ ok: true }>;
    setTheme: (mode: "light" | "dark" | "system") => Promise<{ ok: true }>;
  };
  mcp: {
    list: () => Promise<McpClientListing[]>;
    auth: {
      start: (input: McpAuthStartInput) => Promise<{ sessionId: string }>;
      write: (input: McpAuthWriteInput) => Promise<{ ok: true }>;
      resize: (input: McpAuthResizeInput) => Promise<{ ok: true }>;
      terminate: (sessionId: string) => Promise<{ ok: true }>;
      onData: (listener: (event: McpAuthDataEvent) => void) => () => void;
      onExit: (listener: (event: McpAuthExitEvent) => void) => () => void;
    };
  };
  menu: {
    onCommand: (listener: (command: MenuCommand) => void) => () => void;
  };
  learnings: {
    list: (input: { projectId: string; limit?: number }) => Promise<Learning[]>;
    update: (input: { id: string; summary?: string; verified?: boolean }) => Promise<Learning>;
    delete: (id: string) => Promise<{ ok: true }>;
  };
  prs: {
    listForSession: (input: { sessionId: string }) => Promise<GhPrRecord[]>;
    refresh: (input: { sessionId: string }) => Promise<GhPrRecord[]>;
  };
  git: {
    commit: (input: GitCommitInput) => Promise<GitCommitResult>;
    push: (input: GitPushInput) => Promise<GitPushResult>;
    createBranch: (input: GitCreateBranchInput) => Promise<GitCreateBranchResult>;
    viewOrCreatePr: (input: GitViewOrCreatePrInput) => Promise<GitViewOrCreatePrResult>;
  };
  terminal: {
    spawn: (input: TerminalSpawnInput) => Promise<{ terminalId: string }>;
    write: (input: TerminalWriteInput) => Promise<{ ok: true }>;
    resize: (input: TerminalResizeInput) => Promise<{ ok: true }>;
    terminate: (terminalId: string) => Promise<{ ok: true }>;
    onData: (listener: (event: TerminalDataEvent) => void) => () => void;
    onExit: (listener: (event: TerminalExitEvent) => void) => () => void;
  };
}

export interface GhPrRecord {
  sessionId: string;
  prNumber: number;
  headSha: string;
  lastSeenCheckState: GhCheckState;
  updatedAt: string;
  /** Upper-case state from `gh pr view --json state`. Null for legacy rows. */
  prState?: GhPrState | null;
  /** ISO timestamp the failure follow-up notification last fired for this head_sha. */
  notifiedAt?: string | null;
}

export type GhPrState = "OPEN" | "CLOSED" | "MERGED";

export type GhCheckState =
  | "unknown"
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped";

export type LearningKind = "pitfall" | "convention" | "command";

export interface Learning {
  id: string;
  projectId: string;
  kind: LearningKind;
  summary: string;
  evidenceSessionId: string | null;
  evidenceEventId: string | null;
  verified: boolean;
  hits: number;
  createdAt: string;
  lastSeenAt: string;
}

export type McpTransport = "stdio" | "http" | "sse" | "unknown";
export type McpScope = "user" | "project";

export interface McpServerEntry {
  client: ProviderId;
  name: string;
  transport: McpTransport;
  scope: McpScope;
  source: string;
  command?: string;
  url?: string;
  envKeys: string[];
}

export interface McpClientListing {
  client: ProviderId;
  displayName: string;
  configPath: string | null;
  configExists: boolean;
  servers: McpServerEntry[];
  error: string | null;
}

export type StartupPhase =
  | "boot"
  | "db.open"
  | "services.construct"
  | "ipc.register"
  | "window.create"
  | "window.ready-to-show";

export type MenuCommand =
  | "new-session"
  | "open-settings"
  | "toggle-sidebar"
  | "toggle-debug-log"
  | "open-command-palette"
  | "open-cheat-sheet"
  | "check-for-updates";

declare global {
  interface Window {
    argmax?: ArgmaxApi;
  }
}
