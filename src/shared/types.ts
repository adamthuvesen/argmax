import type * as Bindings from "./bindings.js";
import type { UsageCounts } from "./providerModels.js";

// Backend-derived IPC and diagnostics types come from generated Rust bindings.
// `ArgmaxApi` and renderer-only domain shapes remain hand-written below.
export type AgentMode = Bindings.AgentMode;
export type AttachmentMimeType = Bindings.AttachmentMimeType;
export type DatabaseStats = Bindings.DatabaseStats;
export type DetectedIde = Bindings.DetectedIde;
export type DiagnosticsReport = Bindings.DiagnosticsReport;
export type IdeId = Bindings.IdeId;
export type IpcChannelStats = Bindings.IpcChannelStats;
export type DebugSnapshot = Bindings.DebugSnapshot;
/**
 * A line from the Rust tracing ring buffer. Distinct from `LogEntry` below,
 * which is the renderer's own logger — the two share a shape by coincidence,
 * not by contract, and `level` here is whatever tracing emitted.
 */
export type BackendLogEntry = Bindings.LogEntry;
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
export type RemoteStatus = Bindings.RemoteStatus;
export type StartupPhaseRecord = Bindings.StartupPhaseRecord;

export interface DiscoveredProvider {
  provider: ProviderId;
  displayName: string;
  binaryName: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  /**
   * Tri-state auth signal: `null` = not installed or inconclusive probe,
   * `true` = logged in, `false` = installed but not authenticated. Advisory
   * only; launches are never blocked by this value.
   */
  authenticated: boolean | null;
  setupGuidance: string | null;
  approvalSupport: "unsupported" | "observable-only" | "respondable";
}

export type WorkspaceState =
  | "created"
  | "running"
  | "waiting"
  | "blocked"
  | "complete"
  | "failed"
  | "cancelled"
  | "archiving"
  | "archive-failed"
  | "kept"
  | "archived";

export type SessionState = "created" | "running" | "waiting" | "blocked" | "complete" | "failed" | "cancelled";

export type AttentionState = "normal" | "approval-needed" | "blocked" | "failed" | "review-ready";

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export type EventType =
  | "session.started"
  | "session.streaming"
  | "user.message"
  | "message.delta"
  | "message.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "approval.requested"
  | "permission.blocked"
  | "approval.resolved"
  | "file.changed"
  | "check.started"
  | "check.completed"
  | "error"
  | "session.completed"
  | "session.cancelled"
  | "session.compacting"
  | "session.compacted"
  | "session.provider-changed"
  | "session.cleared"
  | "multitask.launched"
  | "multitask.finished"
  | "session.move-requested"
  | "session.moved"
  | "session.recovered-from-crash";

export interface ProjectSettings {
  worktreeLocation: string;
  setupCommand: string;
  checkCommands: string[];
}

export type RegisterProjectInput = Bindings.ProjectsRegisterInput;
export type RemoveProjectInput = Bindings.ProjectsRemoveInput;
export type UpdateProjectSettingsInput = Bindings.ProjectsUpdateSettingsInput;
export type CreateWorkspaceInput = Bindings.WorkspacesCreateIsolatedInput;
export type CreateCurrentWorkspaceInput = Bindings.WorkspacesCreateCurrentInput;
export type CreateScratchWorkspaceInput = Bindings.WorkspacesCreateScratchInput;
export type AutotitleWorkspaceInput = Bindings.WorkspacesAutotitleInput;
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
export type ProvidersSendQueuedMessageNowInput = Bindings.ProvidersSendQueuedMessageNowInput;
export type ProviderSessionResizeInput = Bindings.ProvidersResizeInput;
export type ComposerAttachment = Bindings.ComposerAttachmentInput;
export type AttachmentSaveImageInput = Bindings.AttachmentsSaveImageInput;
export type AttachmentSaveImageResult = Bindings.SaveImageResult;
export type ResolveApprovalInput = Bindings.ApprovalsResolveInput;
export type SessionEventsSinceInput = OptionalNullable<
  Bindings.SessionEventsSinceInput,
  "eventCursor" | "rawOutputCursor"
>;
export type SessionAgentEventsInput = Bindings.SessionAgentEventsInput;
export type SessionForkInput = Bindings.SessionForkInput;
export type SessionClearInput = Bindings.SessionClearInput;
export type SessionSuggestFollowUpInput = Bindings.SessionSuggestFollowUpInput;
export type FollowUpSuggestion = Bindings.FollowUpSuggestion;
export type SessionForkResult = Bindings.SessionForkResult;
export type MultitaskLaunched = Bindings.MultitaskLaunched;
export type SessionCostSummaryInput = Bindings.SessionCostSummaryInput;
export type WorkspaceStatusInput = OptionalNullable<Bindings.WorkspaceStatusInput, "workspaceIds">;
export type TerminalSpawnInput = Bindings.TerminalSpawnInput;
export type TerminalWriteInput = Bindings.TerminalWriteInput;
export type TerminalResizeInput = Bindings.TerminalResizeInput;

export interface TerminalDataEvent {
  terminalId: string;
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number;
  signal: number | null;
}

export type EventSubscription = (() => void) & {
  ready?: Promise<void>;
};

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

/**
 * Review diff baseline. `workingTree` (default) diffs the working tree against
 * `HEAD` (uncommitted changes); `branch` diffs against the merge-base with the
 * base branch — the whole delta from main, committed + uncommitted + untracked.
 */
export type ReviewComparison = Bindings.ReviewComparison;
export type WorkspaceTarget = Pick<Bindings.WorkspaceListFilesInput, "kind" | "id">;

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
 * Result of `workspace:writeFile`. `ok: "false"` means the file on disk was
 * mutated since the editor last observed it and nothing was written; the
 * renderer surfaces the "changed on disk, reload?" banner with
 * `currentMtimeMs` as the new baseline. The tag is a *string* — Rust serializes
 * the enum with `#[serde(tag = "ok", rename = "true"/"false")]` — so compare it
 * explicitly; a truthiness test passes for both variants.
 */
export type WorkspaceFileWriteResult = Bindings.WorkspaceFileWriteResult;

export type RunCheckInput = Bindings.ChecksRunInput;
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

/**
 * 'git' is a workspace on a real project checkout (worktree or shared);
 * 'scratch' is a repo-less side chat backed by an app-owned directory;
 * 'popup' is the ephemeral scratch behind the "More details" popup, excluded
 * from the sidebar. Repo-coupled UI (review, gh, branch chips, grouping)
 * gates on this field.
 */
export type WorkspaceKind = "git" | "scratch" | "popup";

/** Stable id of the hidden singleton project owning every scratch workspace.
 *  Mirrors `SCRATCH_PROJECT_ID` in src-tauri/src/workspaces/orchestration.rs.
 *  Filter it out of repo pickers and per-project sidebar grouping. */
export const SCRATCH_PROJECT_ID = "scratch-side-chats";

export interface WorkspaceSummary {
  id: string;
  projectId: string;
  taskLabel: string;
  branch: string;
  baseRef: string;
  path: string;
  state: WorkspaceState;
  sharedWorkspace: boolean;
  kind: WorkspaceKind;
  dirty: boolean;
  changedFiles: number;
  lastActivityAt: string;
  pinned: boolean;
  /**
   * When this workspace left the sidebar Priority section (null when not
   * dismissed). Set by right-click "Done" or the header's Clear. Reading a
   * row does not dismiss it — a quiet row ages out of the section on its own
   * (`PRIORITY_IDLE_MS`), leaving no stamp. Spent (ignored) once session
   * attention changes again. Compare against
   * `SessionSummary.attentionChangedAt`. Required, matching the wire shape:
   * an optional marker would let a locally-built summary omit it and erase
   * the dismissal on whole-object delta merge.
   */
  priorityDismissedAt: string | null;
  /**
   * When the user manually added this workspace to the Priority section
   * (null when not manually added). Manual entries need no attention and
   * never age out; cleared by a dismissal or an explicit remove.
   */
  priorityAddedAt: string | null;
  /** State of the most-recent PR across this workspace's sessions. Null/absent when none. */
  prState?: GhPrState | null;
  /** PR number paired with `prState`. */
  prNumber?: number | null;
  /**
   * Curated Lucide icon name the user picked for this row's sidebar glyph
   * (null for none). With no custom icon the row keeps its live status marker.
   */
  icon?: string | null;
  /** Named palette entry paired with `icon`. */
  iconColor?: string | null;
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
  /**
   * When `attention` last changed value. Absent on sessions that predate the
   * column. The Priority section treats a dismissal as current only while
   * `priorityDismissedAt >= attentionChangedAt`.
   */
  attentionChangedAt?: string | null;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  costUsd?: number;
  tokens?: UsageCounts;
  /** Input-side tokens of the latest turn — the live context-window occupancy. */
  contextTokens?: number;
  /** Set only when a provider reports a window on the session. No current
   *  provider does, so the renderer falls back to the per-model table in
   *  `providerModels.ts`. */
  contextWindow?: number | null;
  /** True when the session came from a provider CLI's own transcript store
   *  (Settings → Agents → Session sync) rather than being launched here. */
  imported?: boolean;
  /** The session whose agent launched this one with the `argmax` MCP tools.
   *  Absent for a session the user or a routine started. */
  launchedBySessionId?: string | null;
  /** How this session came to exist: `agent` for one an agent launched and for
   *  every ordinary session, `multitask` for one dispatched from inside
   *  another chat. A multitask stays out of the sidebar — it belongs to the
   *  chat that dispatched it, which shows it in the subagent dock. */
  launchKind?: string;
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
  fastMode?: boolean;
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
  providerInvocationId: string | null;
  providerRequestId: string | null;
  riskLevel: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "cancelled";
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

export interface DashboardSnapshot {
  projects: ProjectSummary[];
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  approvals: ApprovalRequest[];
  checks: CheckRun[];
  /**
   * Per-session queue of follow-ups composed while the agent was running.
   * Full replacement per session id (an empty array clears that session's queue).
   * Omitted on snapshots that pre-date the feature; absent keys mean "no change."
   */
  pendingMessages?: Record<string, PendingMessage[]>;
}

export type DashboardListSnapshot = Pick<
  DashboardSnapshot,
  "projects" | "workspaces" | "sessions" | "checks"
>;

export type WorkspaceStatusSnapshot = Pick<
  DashboardSnapshot,
  "workspaces" | "sessions" | "checks"
>;

export interface SessionEventsSinceResult {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  eventCursor: number;
  rawOutputCursor: number;
}

/** Settings → Agents → Session sync. */
export interface SyncConfigInput {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  opencode: boolean;
  grok: boolean;
  /** 24 or 168; the backend clamps anything else. */
  windowHours: number;
}

export interface SyncStatus {
  config: SyncConfigInput;
  /** Providers whose transcript format Argmax can read; the rest render disabled. */
  supportedProviders: string[];
  lastRunAt: string | null;
  importedCount: number;
  lastError: string | null;
}

/** A stored scheduled task: a prompt plus schedule, fired by the Rust
 *  scheduler as a normal top-level session. Wire shape mirrors the Rust
 *  `Routine` record (see src-tauri/src/persistence/routines.rs).
 *
 *  There is no permission or agent mode here: nobody is watching a scheduled
 *  run, so they always launch auto-approve. The scheduler hardcodes it. */
export interface Routine {
  id: string;
  name: string;
  projectId: string;
  prompt: string;
  provider: ProviderId;
  modelLabel: string;
  modelId: string;
  worktree: boolean;
  /** 6-field cron expression (sec min hour dom month dow); null for one-shots. */
  cronExpr: string | null;
  /** RFC 3339 UTC timestamp; null for recurring schedules. */
  runOnceAt: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineUpsertInput {
  id: string;
  name: string;
  projectId: string;
  prompt: string;
  provider: ProviderId;
  modelLabel: string;
  modelId: string;
  worktree: boolean;
  cronExpr: string | null;
  runOnceAt: string | null;
  enabled?: boolean;
}

export type DashboardDelta = {
  [K in keyof DashboardSnapshot]?: DashboardSnapshot[K];
} & {
  /**
   * Rows to drop rather than merge. The rest of the delta is whole-object
   * replacement, which cannot express "gone"; the session-sync pruner deletes
   * in the background, so it needs an explicit removal signal.
   */
  removedSessionIds?: string[];
  removedWorkspaceIds?: string[];
};

export interface ArgmaxApi {
  dashboard: {
    list: () => Promise<DashboardListSnapshot>;
    onDelta: (listener: (delta: DashboardDelta) => void) => () => void;
  };
  projects: {
    list: () => Promise<ProjectSummary[]>;
    pickFolder: () => Promise<ProjectFolderPickResult>;
    register: (input: RegisterProjectInput) => Promise<ProjectSummary>;
    remove: (input: RemoveProjectInput) => Promise<void>;
    updateSettings: (input: UpdateProjectSettingsInput) => Promise<ProjectSummary>;
    listBranches: (projectId: string) => Promise<string[]>;
    refreshBranch: (projectId: string) => Promise<ProjectSummary>;
    switchBranch: (projectId: string, branch: string) => Promise<ProjectSummary>;
  };
  workspaces: {
    createIsolated: (input: CreateWorkspaceInput) => Promise<WorkspaceSummary>;
    createCurrent: (input: CreateCurrentWorkspaceInput) => Promise<WorkspaceSummary>;
    createScratch: (input: CreateScratchWorkspaceInput) => Promise<WorkspaceSummary>;
    refreshStatus: (workspaceId: string) => Promise<WorkspaceSummary>;
    status: (input?: WorkspaceStatusInput) => Promise<WorkspaceStatusSnapshot>;
    keep: (workspaceId: string) => Promise<WorkspaceSummary>;
    archive: (input: { workspaceId: string; force?: boolean }) => Promise<WorkspaceSummary>;
    openInIde: (input: OpenInIdeInput) => Promise<{ ok: true }>;
    autoTitle: (input: AutotitleWorkspaceInput) => Promise<{ ok: true }>;
    setPinned: (input: { workspaceId: string; pinned: boolean }) => Promise<WorkspaceSummary>;
    setPriorityDismissed: (input: { workspaceId: string; dismissed: boolean }) => Promise<WorkspaceSummary>;
    setPriorityAdded: (input: { workspaceId: string; added: boolean }) => Promise<WorkspaceSummary>;
    setLabel: (input: { workspaceId: string; taskLabel: string }) => Promise<WorkspaceSummary>;
    setIcon: (input: {
      workspaceId: string;
      icon: string | null;
      iconColor: string | null;
    }) => Promise<WorkspaceSummary>;
  };
  providers: {
    discover: (refresh?: boolean) => Promise<DiscoveredProvider[]>;
    launch: (input: LaunchProviderSessionInput) => Promise<SessionSummary>;
    sendInput: (input: ProviderSessionInput) => Promise<{ ok: true; queued: boolean }>;
    resize: (input: ProviderSessionResizeInput) => Promise<{ ok: true }>;
    terminate: (sessionId: string) => Promise<{ ok: true }>;
    cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) => Promise<{ ok: true }>;
    sendQueuedMessageNow: (
      input: ProvidersSendQueuedMessageNowInput
    ) => Promise<{ ok: true; queued: boolean }>;
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
    agentEvents: (input: SessionAgentEventsInput) => Promise<SessionEventsSinceResult>;
    fork: (input: SessionForkInput) => Promise<SessionForkResult>;
    /** Dispatch a multitask: a sibling chat that runs alongside this one's
     *  turn, in the same checkout unless `worktree` asks for its own. */
    multitask: (input: {
      sessionId: string;
      prompt: string;
      worktree?: boolean;
      taskLabel?: string | null;
    }) => Promise<MultitaskLaunched>;
    clear: (input: SessionClearInput) => Promise<SessionSummary>;
    /** A composer placeholder proposed by the cheap helper model from the
     *  agent's last message. `suggestion` is null when there is nothing to
     *  reply to yet or the helper call failed. */
    suggestFollowUp: (input: SessionSuggestFollowUpInput) => Promise<FollowUpSuggestion>;
    costSummary: (input: SessionCostSummaryInput) => Promise<SessionCostSummary>;
    search: (input: { query: string; limit?: number }) => Promise<Array<{
      sessionId: string;
      eventId: string;
      snippet: string;
      rank: number;
    }>>;
  };
  review: {
    listChangedFiles: (target: WorkspaceTarget, comparison?: ReviewComparison) => Promise<ChangedFileSummary[]>;
    /** `contextLines` is only honored for a single-file request; omit it for
     *  git's default context. See ReviewLoadDiffInput. */
    loadDiff: (
      target: WorkspaceTarget,
      filePath?: string,
      comparison?: ReviewComparison,
      contextLines?: number
    ) => Promise<WorkspaceDiff>;
  };
  workspace: {
    listFiles: (target: WorkspaceTarget) => Promise<WorkspaceFileEntry[]>;
    readFile: (target: WorkspaceTarget, filePath: string) => Promise<WorkspaceFilePreview>;
    writeFile: (
      target: WorkspaceTarget,
      filePath: string,
      content: string,
      expectedMtimeMs: number | null
    ) => Promise<WorkspaceFileWriteResult>;
    statFile: (target: WorkspaceTarget, filePath: string) => Promise<WorkspaceFileStat>;
    grepContent: (input: {
      kind: "workspace" | "project";
      id: string;
      query: string;
    }) => Promise<WorkspaceContentSearchResult>;
  };
  checks: {
    run: (input: RunCheckInput) => Promise<CheckRun>;
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
    debugSnapshot: (input?: { afterLogSeq?: number }) => Promise<DebugSnapshot>;
    vacuumDatabase: () => Promise<{ ok: true }>;
    setTheme: (mode: "light" | "dark" | "system") => Promise<{ ok: true }>;
    setDefaultAgent: (input: {
      provider: ProviderId;
      modelLabel: string;
      modelId: string;
      reasoningEffort?: ReasoningEffort | null;
    }) => Promise<{ ok: true }>;
    setNotificationsEnabled: (enabled: boolean) => Promise<{ ok: true }>;
    testNotification: () => Promise<{ ok: true }>;
  };
  remote: {
    getStatus: () => Promise<RemoteStatus>;
    setConfig: (input: { enabled: boolean; port: number; ntfyTopic: string }) => Promise<RemoteStatus>;
    testNotification: () => Promise<{ ok: true }>;
  };
  sync: {
    getStatus: () => Promise<SyncStatus>;
    setConfig: (input: SyncConfigInput) => Promise<SyncStatus>;
    runNow: () => Promise<SyncStatus>;
  };
  routines: {
    list: () => Promise<Routine[]>;
    upsert: (input: RoutineUpsertInput) => Promise<Routine>;
    delete: (id: string) => Promise<null>;
    setEnabled: (id: string, enabled: boolean) => Promise<Routine>;
    runNow: (id: string) => Promise<Routine>;
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
    onData: (listener: (event: TerminalDataEvent) => void) => EventSubscription;
    onExit: (listener: (event: TerminalExitEvent) => void) => EventSubscription;
  };
  browser: {
    open: (input: {
      url: string;
      bounds: BrowserBounds;
      tabId: string;
      /** Session the tab belongs to. Omitted for tabs the user opened, and
       *  when re-materializing a restored tab — the registry keeps the owner
       *  it already has. */
      ownerSessionId?: string | null;
    }) => Promise<{ ok: true }>;
    navigate: (url: string, tabId: string) => Promise<{ ok: true }>;
    back: (tabId: string) => Promise<{ ok: true }>;
    forward: (tabId: string) => Promise<{ ok: true }>;
    reload: (tabId: string) => Promise<{ ok: true }>;
    stop: (tabId: string) => Promise<{ ok: true }>;
    setBounds: (input: { bounds: BrowserBounds; visible: boolean; tabId: string }) => Promise<{ ok: true }>;
    /** Destroys the tab's webview (history and session included). */
    close: (tabId: string) => Promise<{ ok: true }>;
    fillCredentials: (tabId: string) => Promise<BrowserFillResult>;
    /** PNG of the tab, base64. WebKit rasterises on demand, so a hidden tab still captures. */
    screenshot: (input: {
      tabId?: string;
      sessionId?: string;
      rect?: BrowserBounds;
      /** Crop to one snapshot ref; wins over `rect`. */
      ref?: string;
    }) => Promise<BrowserScreenshot>;
    evaluate: (input: { tabId: string; script: string; timeoutMs?: number }) => Promise<BrowserEvaluateResult>;
    /** Live tabs, optionally only one session's. */
    listTabs: (input: { sessionId?: string }) => Promise<{ tabs: BrowserTabInfo[] }>;
    /** Opens a page in a tab owned by a session; the webview starts hidden. */
    openForSession: (input: { url: string; sessionId: string }) => Promise<{ tabId: string }>;
    snapshot: (input: BrowserTabTarget & { interactiveOnly?: boolean }) => Promise<BrowserPageSnapshot>;
    find: (input: BrowserTabTarget & { query: string }) => Promise<BrowserFindResult>;
    getText: (input: BrowserTabTarget & { maxChars?: number }) => Promise<BrowserPageText>;
    act: (input: BrowserTabTarget & { action: BrowserAction }) => Promise<BrowserActionOutcome>;
    onState: (listener: (event: BrowserStateEvent) => void) => EventSubscription;
    onNewTab: (listener: (event: BrowserNewTabEvent) => void) => EventSubscription;
    onPageCommand: (listener: (event: BrowserPageCommandEvent) => void) => EventSubscription;
    /** Whole tab list, pushed whenever it changes. The strip mirrors this. */
    onTabs: (listener: (event: { tabs: BrowserTabInfo[] }) => void) => EventSubscription;
    /** A session opened a tab; its pane switches to Browser mode to show it. */
    onAgentOpen: (listener: (event: BrowserAgentOpenEvent) => void) => EventSubscription;
  };
}

/** Logical (CSS-pixel) rect of the browser pane placeholder. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserStateEvent {
  tabId: string;
  url: string;
  /** Present on page-load finish; absent on plain navigations. */
  title: string | null;
  loading: boolean;
}

/** A page asked for a popup / target="_blank"; the renderer opens a new tab. */
export interface BrowserNewTabEvent {
  tabId: string;
  url: string;
}

/** A browser shortcut pressed while the page itself had focus. */
export interface BrowserPageCommandEvent {
  tabId: string;
  command: "close-tab" | "new-tab" | "focus-address" | (string & {});
}

export interface BrowserScreenshot {
  pngBase64: string;
  /** Device pixels: twice the captured CSS size on a retina display. */
  width: number;
  height: number;
}

export interface BrowserEvaluateResult {
  /** WebKit's JSON encoding of the value. Empty when the script returned `undefined` — or threw. */
  resultJson: string;
}

export interface BrowserFillResult {
  ok: boolean;
  itemTitle: string;
}

/** One live browser tab, as the app (not the renderer) knows it. */
export interface BrowserTabInfo {
  tabId: string;
  /** Session that opened it; null for tabs the user opened. */
  ownerSessionId: string | null;
  url: string;
  title: string | null;
  loading: boolean;
}

export interface BrowserAgentOpenEvent {
  sessionId: string;
  tabId: string;
  url: string;
}

/** Name a tab directly, or let the session's current tab answer. */
export interface BrowserTabTarget {
  tabId?: string;
  sessionId?: string;
}

export interface BrowserPageSnapshot {
  tabId: string;
  url: string;
  title: string;
  /** Indented aria tree; interactive lines carry `[ref=eN]` handles. */
  tree: string;
  truncated: boolean;
}

export interface BrowserFoundElement {
  ref: string;
  role: string;
  name: string;
  value: string;
}

export interface BrowserFindResult {
  tabId: string;
  matches: BrowserFoundElement[];
}

export interface BrowserPageText {
  tabId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface BrowserActionOutcome {
  tabId: string;
  /** URL after the action — a click that navigated says so here. */
  url: string;
  detail: string | null;
}

/** One interaction, addressed by a `[ref=eN]` handle from a snapshot. */
export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit?: boolean }
  | { kind: "select"; ref: string; value: string }
  | { kind: "hover"; ref: string }
  | { kind: "pressKey"; key: string; modifiers?: string[] }
  | { kind: "scroll"; ref?: string; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { kind: "waitFor"; text?: string; ref?: string; urlIncludes?: string; timeoutMs?: number };

export interface GhPrRecord {
  sessionId: string;
  prNumber: number;
  headSha: string;
  lastSeenCheckState: GhCheckState;
  updatedAt: string;
  /** Upper-case state from `gh pr view --json state`. Null when unknown. */
  prState?: GhPrState | null;
  /** ISO timestamp the failure follow-up notification last fired for this head_sha. */
  notifiedAt?: string | null;
  /**
   * Branch the PR was opened from. Sidebar markers resolve by this — a PR
   * belongs to its head branch, not to whichever session happened to be mid-turn
   * when the poller looked. Null on rows recorded before the branch was stored;
   * those still attach to the observing workspace.
   */
  headRefName?: string | null;
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

export type MenuCommand =
  | "new-session"
  | "open-settings"
  | "toggle-sidebar"
  | "toggle-left-sidebar"
  | "toggle-debug-log"
  | "open-command-palette"
  | "open-cheat-sheet"
  | "check-for-updates"
  | "close-surface";

declare global {
  interface Window {
    argmax?: ArgmaxApi;
  }
}
