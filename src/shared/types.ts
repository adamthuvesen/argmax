export type ProviderId = "claude" | "codex";

export type WorkspaceState =
  | "created"
  | "running"
  | "waiting"
  | "blocked"
  | "complete"
  | "failed"
  | "kept"
  | "archived";

export type AttentionState = "normal" | "approval-needed" | "blocked" | "failed" | "review-ready";

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export type EventType =
  | "session.started"
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
  | "session.completed";

export interface ProjectSettings {
  defaultProvider: ProviderId;
  defaultModelLabel: string;
  worktreeLocation: string;
  setupCommand: string;
  checkCommands: string[];
}

export interface RegisterProjectInput {
  repoPath: string;
}

export interface UpdateProjectSettingsInput {
  projectId: string;
  settings: ProjectSettings;
}

export interface CreateWorkspaceInput {
  projectId: string;
  taskLabel: string;
  baseRef?: string;
}

export interface CreateCurrentWorkspaceInput {
  projectId: string;
  taskLabel: string;
}

export interface LaunchProviderSessionInput {
  workspaceId: string;
  provider: ProviderId;
  prompt: string;
  modelLabel: string;
  cols: number;
  rows: number;
}

export interface ProviderSessionInput {
  sessionId: string;
  input: string;
}

export interface ProviderSessionResizeInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ResolveApprovalInput {
  approvalId: string;
  status: "approved" | "rejected";
}

export interface ChangedFileSummary {
  path: string;
  status: string;
}

export interface WorkspaceDiff {
  workspaceId: string;
  filePath: string | null;
  content: string;
}

export interface RunCheckInput {
  workspaceId: string;
  command: string;
}

export interface CreateCheckpointInput {
  workspaceId: string;
  label: string;
}

export interface SelectPreferredAttemptInput {
  sessionId: string;
}

export interface PrepareCommitInput {
  workspaceId: string;
  selectedFiles: string[];
  message: string;
}

export interface CommitPreparation {
  workspaceId: string;
  branch: string;
  selectedFiles: string[];
  message: string;
  commands: string[];
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
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  modelLabel: string;
  prompt: string;
  state: WorkspaceState;
  attention: AttentionState;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  preferred: boolean;
}

export interface TimelineEvent {
  id: string;
  sessionId: string;
  type: EventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RawProviderOutput {
  id: string;
  sessionId: string;
  stream: "stdout" | "stderr" | "pty" | "system";
  content: string;
  createdAt: string;
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

export interface MaestroApi {
  dashboard: {
    load: () => Promise<DashboardSnapshot>;
  };
  projects: {
    list: () => Promise<ProjectSummary[]>;
    register: (input: RegisterProjectInput) => Promise<ProjectSummary>;
    updateSettings: (input: UpdateProjectSettingsInput) => Promise<ProjectSummary>;
  };
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) => Promise<WorkspaceSummary>;
    createCurrent: (input: CreateCurrentWorkspaceInput) => Promise<WorkspaceSummary>;
    refreshStatus: (workspaceId: string) => Promise<WorkspaceSummary>;
    keep: (workspaceId: string) => Promise<WorkspaceSummary>;
    archive: (workspaceId: string) => Promise<WorkspaceSummary>;
  };
  providers: {
    discover: () => Promise<unknown[]>;
    launch: (input: LaunchProviderSessionInput) => Promise<SessionSummary>;
    sendInput: (input: ProviderSessionInput) => Promise<{ ok: true }>;
    resize: (input: ProviderSessionResizeInput) => Promise<{ ok: true }>;
    terminate: (sessionId: string) => Promise<{ ok: true }>;
  };
  approvals: {
    resolve: (input: ResolveApprovalInput) => Promise<ApprovalRequest>;
  };
  review: {
    listChangedFiles: (workspaceId: string) => Promise<ChangedFileSummary[]>;
    loadDiff: (workspaceId: string, filePath?: string) => Promise<WorkspaceDiff>;
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
  commits: {
    prepare: (input: PrepareCommitInput) => Promise<CommitPreparation>;
  };
  health: {
    ping: () => Promise<{ ok: true; timestamp: string }>;
  };
}

declare global {
  interface Window {
    maestro?: MaestroApi;
  }
}
