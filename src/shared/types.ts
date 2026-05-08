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
}

export interface TimelineEvent {
  id: string;
  sessionId: string;
  type: EventType;
  message: string;
  payload: Record<string, unknown>;
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
