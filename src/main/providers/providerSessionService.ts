import { randomUUID } from "node:crypto";
import { RecordNotFoundError, type ArgmaxDatabase } from "../persistence/database.js";
import { computeSessionAttention } from "../sessions/sessionAttention.js";
import { PROVIDER_MODEL_DEFAULTS, type ReasoningEffort } from "../../shared/providerModels.js";
import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import type {
  DashboardDelta,
  AgentMode,
  ComposerAttachment,
  LaunchProviderSessionInput,
  PendingMessage,
  ProviderId,
  SessionSummary
} from "../../shared/types.js";
import { getProviderAdapter } from "./providerAdapters.js";
import { isSessionGoneError } from "./sessionFlushQueue.js";
import { capEventPayload, capRawContent } from "./sessionPayloadCaps.js";
import type { ProviderAdapter, ProviderEvent, ProviderSessionHandle } from "./providerTypes.js";
import type { NotificationService } from "../notifications/notificationService.js";
import { bumpInjectedLearningHits, synthesizeLearnings } from "./providerSessionLearnings.js";
import { recoverOrphanedSessions } from "./providerSessionRecovery.js";
import { composeLearningPreamble } from "../memory/learningInjector.js";
import { promptForAgentMode } from "./agentModePrompt.js";
import { ProviderEventFlushQueue } from "./providerEventFlushQueue.js";

interface FollowUpModelSelection {
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

interface FollowUpOptions {
  modelSelection?: FollowUpModelSelection;
  agentMode?: AgentMode;
  attachments?: ComposerAttachment[];
}

interface PendingOp {
  kind: "send" | "resize" | "terminate";
  payload?: unknown;
}

interface PendingHandleEntry {
  kind: "pending";
  ops: PendingOp[];
  rejected: boolean;
  cancelled: boolean;
}

interface ResolvedHandleEntry {
  kind: "resolved";
  handle: ProviderSessionHandle;
}

type HandleEntry = PendingHandleEntry | ResolvedHandleEntry;

/** Timeout to wait for natural exit during disposeAll before resolving. */
const DISPOSE_GRACE_MS = 2_500;

/**
 * Per-session cap on queued follow-up messages. A renderer can't legitimately
 * need more than a few queued items while the agent is mid-turn; the cap is
 * the line against a runaway script-on-paste growing the queue indefinitely.
 */
const MAX_PENDING_QUEUE = 64;

const STRUCTURED_LAUNCH_COLS = 120;
const STRUCTURED_LAUNCH_ROWS = 32;

function isDebugArgmaxEnabled(): boolean {
  return process.env.DEBUG_ARGMAX === "1";
}

export class ProviderSessionService {
  private readonly handles = new Map<string, HandleEntry>();
  private readonly flushQueue: ProviderEventFlushQueue;
  /**
   * In-memory queue of follow-up messages composed while the agent was working.
   * Per-session FIFO. Drained one-at-a-time when the session reaches `complete`
   * (each queued item becomes a fresh follow-up turn). Cleared on terminate /
   * failure / cancel. Not persisted — a renderer reload or app restart drops it.
   */
  private readonly queues = new Map<string, PendingMessage[]>();

  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly adapterFactory: (provider: ProviderId) => ProviderAdapter = getProviderAdapter,
    private readonly publishDelta: (delta: DashboardDelta) => void = () => undefined,
    private readonly notifications: NotificationService | null = null
  ) {
    this.flushQueue = new ProviderEventFlushQueue(this.database, (delta) => this.publishDelta(delta));
  }

  /** Number of sessions with an active (non-disposed) handle. */
  get openHandleCount(): number {
    let count = 0;
    for (const entry of this.handles.values()) {
      if (entry.kind === "pending" || (entry.kind === "resolved" && !entry.handle.disposed)) {
        count++;
      }
    }
    return count;
  }

  private logHandleCount(action: string, sessionId: string): void {
    if (!isDebugArgmaxEnabled()) return;
    logger.debug("providers.session", "handle count", {
      handles: this.openHandleCount,
      action,
      sessionId
    });
  }

  async launch(input: LaunchProviderSessionInput): Promise<SessionSummary> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const sessionId = randomUUID();
    const agentMode = input.agentMode ?? "auto";

    // Inject project-scoped learnings into the prompt the provider sees, but
    // keep the user-visible `input.prompt` on the session row and timeline.
    // The renderer renders only the original; the agent sees the preamble.
    const { augmentedPrompt, injectedIds } = composeLearningPreamble(
      this.database,
      workspace.projectId,
      input.prompt
    );

    let session = this.database.persistSession({
      id: sessionId,
      workspaceId: workspace.id,
      provider: input.provider,
      modelLabel: input.modelLabel,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode ?? "auto-approve",
      agentMode,
      prompt: input.prompt,
      state: "running",
      attention: computeSessionAttention({ state: "running" })
    });
    if (input.provider === "claude") {
      session = this.database.updateSessionProviderConversationId(sessionId, sessionId);
    }

    const runningWorkspace = this.database.updateWorkspaceState(workspace.id, "running");
    const userMessage = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "user.message",
      message: input.prompt,
      payload: {
        source: "composer",
        agentMode,
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }
    });
    const sessionStarted = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "session.started",
      message: `${input.provider} session started.`,
      payload: {
        provider: input.provider,
        workspacePath: workspace.path,
        modelLabel: input.modelLabel,
        agentMode,
        ...(session.providerConversationId
          ? {
              providerConversationId: session.providerConversationId
            }
          : {})
      }
    });
    this.flushQueue.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [runningWorkspace],
      sessions: [session],
      events: [userMessage, sessionStarted]
    });

    this.flushQueue.initializeBuffer(sessionId, workspace.id, workspace.path, input.provider, input.modelId);
    // Register a pending placeholder synchronously so any racing operations are
    // queued into arrival order against the real handle once launch resolves.
    const pending: PendingHandleEntry = { kind: "pending", ops: [], rejected: false, cancelled: false };
    this.handles.set(sessionId, pending);

    const adapter = this.adapterFactory(input.provider);
    try {
      const handle = await adapter.launch(
        {
          sessionId,
          workspacePath: workspace.path,
          prompt: augmentedPrompt,
          modelLabel: input.modelLabel,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          resumeConversationId: undefined,
          mode: PROVIDER_MODEL_DEFAULTS[input.provider].launchMode,
          permissionMode: input.permissionMode ?? "auto-approve",
          agentMode,
          cols: input.cols,
          rows: input.rows
        },
        (event) => this.handleProviderEvent(workspace.id, input.provider, event)
      );
      // If the placeholder was rejected (e.g., a concurrent launch failure path
      // ran), drop the resolved handle and terminate the freshly spawned child.
      if (pending.rejected) {
        // Swallow non-ESRCH terminate errors (EPERM/EINVAL from the SIGKILL
        // escalator) so the cancellation message below is the one that
        // propagates, not a kill-path side effect.
        void handle.terminate().catch(() => undefined);
        throw new Error("Provider launch was cancelled before handle registration.");
      }
      this.handles.set(sessionId, { kind: "resolved", handle });
      this.logHandleCount("opened", sessionId);

      // Bump hits + last_seen_at on injected learnings so the next launch
      // prefers facts that have already proven useful for this project.
      if (injectedIds.length > 0) {
        this.bumpInjectedLearningHits(injectedIds);
      }
      // Replay queued operations in arrival order.
      for (const op of pending.ops) {
        this.applyOpToHandle(handle, op);
      }
      pending.ops.length = 0;
      return session;
    } catch (error) {
      this.handles.delete(sessionId);
      pending.rejected = true;
      pending.ops.length = 0;
      if (pending.cancelled) {
        throw error;
      }
      this.recordLaunchFailure({
        sessionId,
        workspaceId: workspace.id,
        provider: input.provider,
        error,
        fallbackMessage: "Provider launch failed."
      });
      throw error;
    }
  }

  async sendInput(
    sessionId: string,
    input: string,
    options: FollowUpOptions = {}
  ): Promise<{ queued: boolean }> {
    const message = input.replace(/\r?\n$/, "").trim();
    if (!message) {
      return { queued: false };
    }

    let session = this.database.getSession(sessionId);
    const workspace = this.database.getWorkspace(session.workspaceId);
    const agentMode = options.agentMode ?? session.agentMode ?? "auto";
    const existingEntry = this.handles.get(sessionId);
    const liveHandle = this.getLiveHandle(sessionId);
    // Busy paths: launch still resolving, or a live PTY that isn't accepting
    // input right now. Park the message in the per-session queue and let the
    // exit-branch drain pick it up when the current turn finishes.
    if (existingEntry?.kind === "pending" || (liveHandle && !liveHandle.acceptsInput)) {
      this.enqueuePendingMessage(sessionId, message, agentMode, options);
      return { queued: true };
    }
    if (liveHandle) {
      if (session.agentMode !== agentMode) {
        session = this.database.updateSessionAgentMode(sessionId, { agentMode });
      }
      // Collapse embedded newlines so the PTY-side CLI doesn't treat each line
      // as a separate prompt submission. The persisted user.message keeps the
      // original text — only what travels to the live PTY is sanitized.
      const ptyPayload = promptForAgentMode(message, agentMode).replace(/\r?\n/g, " ");
      liveHandle.sendInput(`${ptyPayload}\r`);
    }

    const userMessage = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "user.message",
      message,
      payload: {
        source: "composer",
        agentMode,
        ...(options.attachments?.length ? { attachments: options.attachments } : {})
      }
    });
    if (liveHandle) {
      this.flushQueue.publishDashboardDelta({ events: [userMessage] });
      return { queued: false };
    }

    if (options.modelSelection) {
      session = this.database.updateSessionModel(sessionId, options.modelSelection);
    }
    if (session.agentMode !== agentMode) {
      session = this.database.updateSessionAgentMode(sessionId, { agentMode });
    }

    const runningSession = this.database.updateSessionState(sessionId, {
      state: "running",
      attention: computeSessionAttention({ state: "running" }),
      completedAt: null
    });
    const runningWorkspace = this.database.updateWorkspaceState(workspace.id, "running");
    this.flushQueue.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [runningWorkspace],
      sessions: [runningSession],
      events: [userMessage]
    });

    this.flushQueue.initializeBuffer(sessionId, workspace.id, workspace.path, session.provider, session.modelId);
    const pending: PendingHandleEntry = { kind: "pending", ops: [], rejected: false, cancelled: false };
    this.handles.set(sessionId, pending);
    const modelDefault = PROVIDER_MODEL_DEFAULTS[session.provider];

    try {
      const handle = await this.adapterFactory(session.provider).launch(
        {
          sessionId,
          workspacePath: workspace.path,
          prompt: message,
          modelLabel: session.modelLabel,
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort,
          ...(session.providerConversationId ? { resumeConversationId: session.providerConversationId } : {}),
          mode: modelDefault.launchMode,
          permissionMode: session.permissionMode,
          agentMode,
          cols: STRUCTURED_LAUNCH_COLS,
          rows: STRUCTURED_LAUNCH_ROWS
        },
        (event) => this.handleProviderEvent(workspace.id, session.provider, event)
      );
      if (pending.rejected) {
        // Swallow non-ESRCH terminate errors (EPERM/EINVAL from the SIGKILL
        // escalator) so the cancellation message below is the one that
        // propagates, not a kill-path side effect.
        void handle.terminate().catch(() => undefined);
        throw new Error("Provider launch was cancelled before handle registration.");
      }
      this.handles.set(sessionId, { kind: "resolved", handle });
      this.logHandleCount("reopened", sessionId);
      for (const op of pending.ops) {
        this.applyOpToHandle(handle, op);
      }
      pending.ops.length = 0;
      return { queued: false };
    } catch (error) {
      this.handles.delete(sessionId);
      pending.rejected = true;
      pending.ops.length = 0;
      if (pending.cancelled) {
        throw error;
      }
      this.recordLaunchFailure({
        sessionId,
        workspaceId: workspace.id,
        provider: session.provider,
        error,
        fallbackMessage: "Provider input failed."
      });
      throw error;
    }
  }

  private recordLaunchFailure(args: {
    sessionId: string;
    workspaceId: string;
    provider: ProviderId;
    error: unknown;
    fallbackMessage: string;
  }): void {
    this.flushQueue.deleteBuffer(args.sessionId);
    const message = args.error instanceof Error ? args.error.message : args.fallbackMessage;
    const failedSession = this.database.updateSessionState(args.sessionId, {
      state: "failed",
      attention: computeSessionAttention({ state: "failed" }),
      completedAt: new Date().toISOString()
    });
    this.notifications?.notify(failedSession);
    const failedWorkspace = this.database.updateWorkspaceState(args.workspaceId, "failed");
    const errorEvent = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId: args.sessionId,
      type: "error",
      message,
      payload: {
        provider: args.provider
      }
    });
    this.flushQueue.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [failedWorkspace],
      sessions: [failedSession],
      events: [errorEvent]
    });
    // A launch / re-launch that failed cannot drain queued follow-ups — drop
    // them rather than auto-firing into a session the renderer just saw fail.
    this.clearQueue(args.sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.handles.get(sessionId);
    if (!entry) {
      return;
    }
    if (entry.kind === "pending") {
      // Latest-wins for resize: only the most recent dimensions matter once
      // the handle resolves. Without this, a renderer storming resize() during
      // launch could grow ops without bound. Drop any earlier resize so we
      // replay exactly one.
      entry.ops = entry.ops.filter((op) => op.kind !== "resize");
      entry.ops.push({ kind: "resize", payload: { cols, rows } });
      return;
    }
    if (entry.handle.disposed) {
      return;
    }
    entry.handle.resize(cols, rows);
  }

  async terminate(sessionId: string): Promise<void> {
    const entry = this.handles.get(sessionId);
    if (!entry) {
      // Terminate is also a "give up on whatever was queued" signal — even if
      // there's no live handle (already complete), drop any pending follow-ups
      // the user lined up so the next launch doesn't auto-flush them.
      this.clearQueue(sessionId);
      return;
    }
    if (entry.kind === "pending") {
      entry.cancelled = true;
      entry.rejected = true;
      entry.ops.length = 0;
      this.handles.delete(sessionId);
      this.clearQueue(sessionId);
      this.cancelSession(sessionId);
      return;
    }
    if (entry.handle.disposed) {
      this.clearQueue(sessionId);
      return;
    }
    // Flush any buffered partial line so the trailing fragment surfaces before
    // termination tears down the per-session state.
    this.flushQueue.flushTrailingFragment(sessionId);
    this.flushQueue.flushBatch(sessionId);
    this.clearQueue(sessionId);
    await entry.handle.terminate();
    this.cancelSession(sessionId);
  }

  /**
   * Enqueue a follow-up composed while the agent was running. Publishes a
   * `pendingMessages` delta so the renderer can render the queued chip.
   */
  private enqueuePendingMessage(
    sessionId: string,
    content: string,
    agentMode: AgentMode,
    options: FollowUpOptions
  ): PendingMessage {
    const entry: PendingMessage = {
      id: randomUUID(),
      sessionId,
      content,
      agentMode,
      queuedAt: new Date().toISOString(),
      ...(options.modelSelection?.modelLabel ? { modelLabel: options.modelSelection.modelLabel } : {}),
      ...(options.modelSelection?.modelId ? { modelId: options.modelSelection.modelId } : {}),
      ...(options.modelSelection?.reasoningEffort
        ? { reasoningEffort: options.modelSelection.reasoningEffort }
        : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {})
    };
    const queue = this.queues.get(sessionId) ?? [];
    // Per-session FIFO cap. A renderer can't legitimately need more than a
    // few queued follow-ups; without a cap, a runaway script-on-paste could
    // grow the queue indefinitely while the agent is busy.
    if (queue.length >= MAX_PENDING_QUEUE) {
      throw new Error(
        `Pending follow-up queue is full (${MAX_PENDING_QUEUE}). Wait for the current turn to finish before queuing more.`
      );
    }
    queue.push(entry);
    this.queues.set(sessionId, queue);
    this.publishPendingMessages(sessionId);
    return entry;
  }

  /**
   * Drop a single queued follow-up by id. No-op if the message has already been
   * popped by the drain loop or the session has been cancelled.
   */
  cancelQueuedMessage(sessionId: string, messageId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.id === messageId);
    if (index === -1) return;
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    }
    this.publishPendingMessages(sessionId);
  }

  /** Drop the entire queue for a session and notify the renderer. */
  private clearQueue(sessionId: string): void {
    if (!this.queues.has(sessionId)) return;
    this.queues.delete(sessionId);
    this.publishPendingMessages(sessionId);
  }

  /** Snapshot of every session's queue. Used by the dashboard:load handler. */
  getAllPendingMessages(): Record<string, PendingMessage[]> {
    const out: Record<string, PendingMessage[]> = {};
    for (const [sessionId, queue] of this.queues) {
      if (queue.length > 0) {
        out[sessionId] = queue.map((entry) => ({ ...entry }));
      }
    }
    return out;
  }

  private publishPendingMessages(sessionId: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    this.flushQueue.publishDashboardDelta({
      pendingMessages: { [sessionId]: queue.map((entry) => ({ ...entry })) }
    });
  }

  /**
   * Drain the head of the queue as a fresh follow-up turn after the previous
   * turn reached `complete`. Fire-and-forget: failure is logged but does not
   * propagate, so a single bad message can't poison subsequent turns. Each
   * drained message ships the model + agentMode it was queued with.
   */
  private drainQueueAfterComplete(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    } else {
      this.queues.set(sessionId, queue);
    }
    this.publishPendingMessages(sessionId);
    const options: FollowUpOptions = {
      agentMode: next.agentMode,
      ...(next.modelLabel && next.modelId
        ? {
            modelSelection: {
              modelLabel: next.modelLabel,
              modelId: next.modelId,
              ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {})
            }
          }
        : {}),
      ...(next.attachments?.length ? { attachments: next.attachments } : {})
    };
    this.sendInput(sessionId, next.content, options).catch((error) => {
      logger.warn("providers.session", "drainQueueAfterComplete failed", {
        sessionId,
        messageId: next.id,
        error: errorMessage(error)
      });
    });
  }

  /**
   * Reconcile sessions that the database still marks `running` but for which
   * no live handle exists. Intended to run exactly once at app boot — any row
   * in this state at startup was abandoned by a previous process (crash, kill,
   * power loss). Each surviving row transitions to `cancelled` with a synthetic
   * `session.recovered-from-crash` timeline event so users see why a session
   * they expected to be live is no longer running.
   */
  private bumpInjectedLearningHits(ids: readonly string[]): void {
    bumpInjectedLearningHits(this.database, ids);
  }

  private synthesizeLearnings(sessionId: string, workspaceId: string): void {
    synthesizeLearnings(this.database, sessionId, workspaceId);
  }

  recoverOrphanedSessions(): { recoveredCount: number } {
    return recoverOrphanedSessions(this.database, (delta) => this.publishDelta(delta));
  }

  private cancelSession(sessionId: string): void {
    this.flushQueue.flushTrailingFragment(sessionId);
    this.flushQueue.flushBatch(sessionId);
    const completedAt = new Date().toISOString();
    const bufferWorkspaceId = this.flushQueue.getBufferWorkspaceId(sessionId);
    // If the in-memory buffer is gone AND the session row was also deleted
    // (workspace archived mid-terminate, CASCADE), there's nothing to cancel.
    // Surfacing a RecordNotFoundError to IPC for a benign race is noise.
    // (audit-2026-05-17 H6)
    let workspaceId: string;
    if (bufferWorkspaceId) {
      workspaceId = bufferWorkspaceId;
    } else {
      try {
        workspaceId = this.database.getSession(sessionId).workspaceId;
      } catch (error) {
        if (error instanceof RecordNotFoundError && error.kind === "session") {
          this.handles.delete(sessionId);
          this.clearQueue(sessionId);
          return;
        }
        throw error;
      }
    }
    const session = this.database.updateSessionState(sessionId, {
      state: "cancelled",
      attention: computeSessionAttention({ state: "cancelled" }),
      completedAt,
      lastActivityAt: completedAt
    });
    const workspace = this.database.updateWorkspaceState(workspaceId, "cancelled");
    const event = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "session.cancelled",
      message: "Provider session cancelled.",
      payload: {},
      createdAt: completedAt
    });
    this.handles.delete(sessionId);
    this.logHandleCount("cancelled", sessionId);
    this.flushQueue.deleteBuffer(sessionId);
    this.clearQueue(sessionId);
    this.flushQueue.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [workspace],
      sessions: [session],
      events: [event]
    });
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.handles.keys()];
    if (isDebugArgmaxEnabled() && sessions.length > 0) {
      logger.debug("providers.session", "disposeAll terminating handles", { count: sessions.length });
    }
    await Promise.allSettled(
      sessions.map(async (sessionId) => {
        const entry = this.handles.get(sessionId);
        if (!entry) {
          return;
        }
        if (entry.kind === "pending") {
          entry.cancelled = true;
          entry.rejected = true;
          this.handles.delete(sessionId);
          this.flushQueue.deleteBuffer(sessionId);
          return;
        }
        if (entry.handle.disposed) {
          return;
        }
        this.flushQueue.flushTrailingFragment(sessionId);
        this.flushQueue.flushBatch(sessionId);
        // terminate() resolves on real child exit; the race is a safety net
        // for the unkillable-child case so disposeAll can't hang shutdown.
        await Promise.race([
          entry.handle.terminate(),
          new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS))
        ]);
      })
    );
  }

  /** Internal helper exposed via test surface; returns null when disposed/missing. */
  private getLiveHandle(sessionId: string): ProviderSessionHandle | null {
    const entry = this.handles.get(sessionId);
    if (!entry || entry.kind !== "resolved") {
      return null;
    }
    return entry.handle.disposed ? null : entry.handle;
  }

  private applyOpToHandle(handle: ProviderSessionHandle, op: PendingOp): void {
    if (handle.disposed) {
      return;
    }
    if (op.kind === "send") {
      const data = (op.payload as { data: string }).data;
      handle.sendInput(data);
      return;
    }
    if (op.kind === "resize") {
      const { cols, rows } = op.payload as { cols: number; rows: number };
      handle.resize(cols, rows);
      return;
    }
    if (op.kind === "terminate") {
      void handle.terminate();
    }
  }

  private handleProviderEvent(
    workspaceId: string,
    provider: ProviderId,
    event: ProviderEvent
  ): void {
    if (event.type === "output") {
      this.flushQueue.handleOutputEvent(provider, event);
      return;
    }

    // Lifecycle event: flush any held partial line and any pending batch
    // synchronously, then update state and remove the handle.
    this.flushQueue.flushTrailingFragment(event.sessionId);
    this.flushQueue.flushBatch(event.sessionId);

    const completedAt = event.createdAt;
    const succeeded = event.type === "exit" && event.exitCode === 0;
    const state = succeeded ? "complete" : "failed";
    try {
      const rawOutputInput = {
        id: randomUUID(),
        sessionId: event.sessionId,
        stream: event.stream,
        content: capRawContent(event.message).content,
        createdAt: event.createdAt
      };
      const rawOutput = this.database.persistRawOutput(rawOutputInput);
      const session = this.database.updateSessionState(event.sessionId, {
        state,
        attention: computeSessionAttention({ state }),
        completedAt,
        lastActivityAt: completedAt
      });
      this.notifications?.notify(session);
      const workspace = this.database.updateWorkspaceState(workspaceId, state);
      const timelineEvent = this.database.persistTimelineEvent({
        id: randomUUID(),
        sessionId: event.sessionId,
        type: succeeded ? "session.completed" : "error",
        message: event.message,
        payload: capEventPayload({
          exitCode: event.exitCode
        }).payload,
        createdAt: event.createdAt
      });
      this.flushQueue.publishDashboardDelta({
        projects: this.database.listProjects(),
        workspaces: [workspace],
        sessions: [session],
        events: [timelineEvent],
        rawOutputs: [rawOutput]
      });
      if (succeeded) {
        this.synthesizeLearnings(event.sessionId, workspaceId);
      } else {
        // Failure path — the session is dead from the user's perspective, so
        // drop any follow-ups they'd lined up rather than auto-firing them
        // against a session that just errored.
        this.clearQueue(event.sessionId);
      }
    } catch (error) {
      // Race: session or workspace was deleted between buffer flush and
      // lifecycle write. The local handle still needs cleanup; skip the
      // delta — the renderer will pick up the deletion via status poll.
      const rowGone =
        isSessionGoneError(error, event.sessionId) ||
        (error instanceof RecordNotFoundError && error.kind === "workspace");
      if (!rowGone) {
        throw error;
      }
    }
    this.handles.delete(event.sessionId);
    this.logHandleCount("closed", event.sessionId);
    this.flushQueue.deleteBuffer(event.sessionId);
    // Drain runs AFTER the handle is gone so the re-launch path in sendInput
    // doesn't try to write into the dead PTY. No-op when the queue is empty
    // or the session didn't succeed (failure cleared it above).
    if (succeeded) {
      this.drainQueueAfterComplete(event.sessionId);
    }
  }

  /** Test surface: delegates to the flush queue micro-batch drain. */
  private flushBatch(sessionId: string): void {
    this.flushQueue.flushBatch(sessionId);
  }
}
