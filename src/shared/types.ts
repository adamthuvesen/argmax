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
  LaunchProviderSessionInputParsed,
  PrepareCommitInputParsed,
  ProviderSessionInputParsed,
  ProviderSessionResizeInputParsed,
  RegisterProjectInputParsed,
  ResolveApprovalInputParsed,
  RunCheckInputParsed,
  SessionEventsSinceInputParsed,
  SelectPreferredAttemptInputParsed,
  SkillsListInputParsed,
  UpdateProjectSettingsInputParsed,
  WorkspaceStatusInputParsed
} from "./ipcSchemas.js";
import type { ReasoningEffort } from "./providerModels.js";

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

export type SessionState = "created" | "running" | "waiting" | "blocked" | "complete" | "failed";

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
  | "session.completed";

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
export type WorkspaceStatusInput = WorkspaceStatusInputParsed;

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

export type RunCheckInput = RunCheckInputParsed;
export type CreateCheckpointInput = CreateCheckpointInputParsed;
export type SelectPreferredAttemptInput = SelectPreferredAttemptInputParsed;
export type PrepareCommitInput = PrepareCommitInputParsed;
export type SkillsListInput = SkillsListInputParsed;

export type SkillSource = "user" | "workspace" | "codex-prompt" | "plugin" | "system";

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
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
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  providerConversationId: string | null;
  prompt: string;
  state: SessionState;
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

export interface MaestroApi {
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
  };
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) => Promise<WorkspaceSummary>;
    createCurrent: (input: CreateCurrentWorkspaceInput) => Promise<WorkspaceSummary>;
    refreshStatus: (workspaceId: string) => Promise<WorkspaceSummary>;
    status: (input?: WorkspaceStatusInput) => Promise<WorkspaceStatusSnapshot>;
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
    pending: () => Promise<ApprovalRequest[]>;
    resolve: (input: ResolveApprovalInput) => Promise<ApprovalRequest>;
  };
  session: {
    eventsSince: (input: SessionEventsSinceInput) => Promise<SessionEventsSinceResult>;
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
  skills: {
    list: (input: SkillsListInput) => Promise<SkillSummary[]>;
  };
}

declare global {
  interface Window {
    maestro?: MaestroApi;
  }
}
