/**
 * IPC-input types are inferred from the zod schemas in `./ipcSchemas.ts`
 * via `import type` so the renderer never pulls zod into its bundle. The
 * `import type` form erases at runtime; only the type signatures cross
 * this boundary.
 */
import type {
  CreateCheckpointInputParsed,
  CreateCurrentWorkspaceInputParsed,
  CreateWorkspaceInputParsed,
  GitCommitInputParsed,
  GitCreateBranchInputParsed,
  GitPushInputParsed,
  GitViewOrCreatePrInputParsed,
  IdeIdParsed,
  LaunchProviderSessionInputParsed,
  McpAuthResizeInputParsed,
  McpAuthStartInputParsed,
  McpAuthWriteInputParsed,
  OpenInIdeInputParsed,
  ProviderSessionInputParsed,
  ProviderSessionResizeInputParsed,
  RegisterProjectInputParsed,
  ResolveApprovalInputParsed,
  RunCheckInputParsed,
  SessionCostSummaryInputParsed,
  SessionEventsSinceInputParsed,
  SelectPreferredAttemptInputParsed,
  SkillsListInputParsed,
  TerminalResizeInputParsed,
  TerminalSpawnInputParsed,
  TerminalWriteInputParsed,
  UpdateProjectSettingsInputParsed,
  WorkspaceStatusInputParsed
} from "./ipcSchemas.js";
import type { ReasoningEffort, UsageCounts } from "./providerModels.js";

export type ProviderId = "claude" | "codex" | "cursor";
export type ProviderMode = "interactive-pty" | "structured-json";
export type PermissionMode = "auto-approve" | "ask-each-time";

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

export type RegisterProjectInput = RegisterProjectInputParsed;
export type UpdateProjectSettingsInput = UpdateProjectSettingsInputParsed;
export type CreateWorkspaceInput = CreateWorkspaceInputParsed;
export type CreateCurrentWorkspaceInput = CreateCurrentWorkspaceInputParsed;
export type LaunchProviderSessionInput = LaunchProviderSessionInputParsed;
export type ProviderSessionInput = ProviderSessionInputParsed;
export type ProviderSessionResizeInput = ProviderSessionResizeInputParsed;
export type ResolveApprovalInput = ResolveApprovalInputParsed;
export type SessionEventsSinceInput = SessionEventsSinceInputParsed;
export type SessionCostSummaryInput = SessionCostSummaryInputParsed;
export type WorkspaceStatusInput = WorkspaceStatusInputParsed;
export type TerminalSpawnInput = TerminalSpawnInputParsed;
export type TerminalWriteInput = TerminalWriteInputParsed;
export type TerminalResizeInput = TerminalResizeInputParsed;
export type McpAuthStartInput = McpAuthStartInputParsed;
export type McpAuthWriteInput = McpAuthWriteInputParsed;
export type McpAuthResizeInput = McpAuthResizeInputParsed;

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
 * Result of `workspace:writeFile`. `ok: false, reason: "stale"` means the file
 * on disk was mutated since the editor last observed it; the renderer should
 * surface the "changed on disk, reload?" banner with `currentMtimeMs` as the
 * new baseline if the user chooses to keep their edits.
 */
export type WorkspaceFileWriteResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; reason: "stale"; currentMtimeMs: number; size: number };

export type RunCheckInput = RunCheckInputParsed;
export type CreateCheckpointInput = CreateCheckpointInputParsed;
export type SelectPreferredAttemptInput = SelectPreferredAttemptInputParsed;
export type GitCommitInput = GitCommitInputParsed;
export type GitPushInput = GitPushInputParsed;
export type GitCreateBranchInput = GitCreateBranchInputParsed;
export type GitViewOrCreatePrInput = GitViewOrCreatePrInputParsed;

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
export type SkillsListInput = SkillsListInputParsed;
export type OpenInIdeInput = OpenInIdeInputParsed;
export type IdeId = IdeIdParsed;

export interface DetectedIde {
  id: IdeId;
  label: string;
  appPath: string | null;
  hasCli: boolean;
}

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
  providerConversationId: string | null;
  prompt: string;
  state: SessionState;
  attention: AttentionState;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  preferred: boolean;
  costUsd?: number;
  tokens?: UsageCounts;
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
    archive: (workspaceId: string) => Promise<WorkspaceSummary>;
    openInIde: (input: OpenInIdeInput) => Promise<{ ok: true }>;
    setPinned: (input: { workspaceId: string; pinned: boolean }) => Promise<WorkspaceSummary>;
  };
  providers: {
    discover: () => Promise<DiscoveredProvider[]>;
    launch: (input: LaunchProviderSessionInput) => Promise<SessionSummary>;
    sendInput: (input: ProviderSessionInput) => Promise<{ ok: true }>;
    resize: (input: ProviderSessionResizeInput) => Promise<{ ok: true }>;
    terminate: (sessionId: string) => Promise<{ ok: true }>;
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
  };
  checks: {
    run: (input: RunCheckInput) => Promise<CheckRun>;
  };
  checkpoints: {
    create: (input: CreateCheckpointInput) => Promise<Checkpoint>;
  };
  attempts: {
    selectPreferred: (input: SelectPreferredAttemptInput) => Promise<SessionSummary>;
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
}

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

export interface StartupPhaseRecord {
  phase: StartupPhase;
  /** Milliseconds since the main process started. */
  elapsedMs: number;
  /** Milliseconds since the previous phase mark (0 for the first). */
  deltaMs: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  /** JSON-serializable structured fields. Always present (may be empty). */
  fields: Record<string, unknown>;
}

export interface IpcChannelStats {
  channel: string;
  /** Samples in the rolling 100-call window. */
  count: number;
  /** Total samples ever recorded for the channel. */
  totalRecorded: number;
  /** p50 latency in milliseconds (rolling window). */
  p50: number;
  /** p99 latency in milliseconds (rolling window). */
  p99: number;
}

export interface DatabaseStats {
  /** Row counts per major table. */
  rowCounts: {
    projects: number;
    workspaces: number;
    sessions: number;
    events: number;
    rawOutputs: number;
    approvals: number;
    checks: number;
    checkpoints: number;
    learnings: number;
    usageEvents: number;
  };
  /** Bytes — size of the WAL sidecar file. 0 when missing or unreadable. */
  walBytes: number;
  /** Value of `PRAGMA wal_autocheckpoint` (pages between auto-checkpoints). */
  walAutocheckpoint: number;
}

export interface DiagnosticsReport {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  sqliteVersion: string;
  databasePath: string;
  platform: string;
  arch: string;
  generatedAt: string;
  /**
   * Per-phase timings for the current boot. Diagnostics → Startup panel
   * (SPEC P7.04) renders these and flags any phase that exceeds the budget
   * documented in `agents/docs/performance.md`.
   */
  startupPhases: StartupPhaseRecord[];
  /**
   * Live database health stats. Diagnostics → Database panel (SPEC P7.03)
   * renders row counts + WAL size + autocheckpoint pragma.
   */
  databaseStats: DatabaseStats;
  /**
   * Per-channel IPC latency stats. Diagnostics → IPC panel (SPEC P7.02)
   * renders this. Empty array when no channels have been sampled yet.
   */
  ipcStats: IpcChannelStats[];
  /**
   * Tail of the main-process log ring buffer (most recent 200 entries).
   * Diagnostics → Logs panel (SPEC P7.01) renders this.
   */
  recentLogs: LogEntry[];
}

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
