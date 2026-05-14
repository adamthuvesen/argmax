import { randomUUID } from "node:crypto";
import { RecordNotFoundError, type ArgmaxDatabase, type PersistTimelineEventInput } from "../persistence/database.js";
import { computeSessionAttention } from "../sessions/sessionAttention.js";
import { PROVIDER_MODEL_DEFAULTS, type ReasoningEffort } from "../../shared/providerModels.js";
import { logger } from "../../shared/logger.js";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import type {
  DashboardDelta,
  LaunchProviderSessionInput,
  ProviderId,
  SessionSummary,
  TimelineEvent
} from "../../shared/types.js";
import { getProviderAdapter } from "./providerAdapters.js";
import {
  createNormalizerSessionContext,
  normalizeProviderEventWithUsage,
  type NormalizedUsage,
  type NormalizerSessionContext
} from "./providerEventNormalizer.js";
import {
  flushSessionBuffer,
  isSessionGoneError,
  scheduleFlush as scheduleFlushQueue
} from "./sessionFlushQueue.js";
import {
  capEventPayload,
  capRawContent,
  capRawTruncationMarker,
  extractProviderConversationId
} from "./sessionPayloadCaps.js";
import type { ProviderAdapter, ProviderEvent, ProviderSessionHandle } from "./providerTypes.js";
import type { NotificationService } from "../notifications/notificationService.js";
import { extractLearningCandidates } from "../memory/learningExtractor.js";
import { composeLearningPreamble } from "../memory/learningInjector.js";

interface FollowUpModelSelection {
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

interface PendingOp {
  kind: "send" | "resize" | "terminate";
  payload?: unknown;
}

interface SessionBuffer {
  /**
   * Per-stream line buffers. Each stream (stdout/stderr/pty) is reassembled
   * independently so that a partial JSON object on stdout never gets glued to
   * an unrelated PTY chunk. Trailing partial lines are flushed on terminate.
   */
  streamBuffers: Map<ProviderEvent["stream"], string>;
  sequence: number;
  lastFlushAt: number;
  flushTimer: NodeJS.Timeout | null;
  /** Coalesced events accumulated during the current micro-batch window. */
  pendingEvents: PersistTimelineEventInput[];
  /** Coalesced raw outputs for the current micro-batch window. */
  pendingRawOutputs: Array<{
    id: string;
    sessionId: string;
    stream: ProviderEvent["stream"];
    content: string;
    createdAt: string;
  }>;
  /** Coalesced usage events accumulated during the current micro-batch window. */
  pendingUsages: NormalizedUsage[];
  pendingSessionUpdate: SessionSummary | null;
  /** Latest output createdAt seen, used for throttled lastActivityAt updates. */
  lastActivityWriteAt: number;
  workspaceId: string;
  provider: ProviderId;
  /** Session-scoped normalizer context, e.g. most-recent Codex turn_context model. */
  normalizerContext: NormalizerSessionContext;
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

/** 2 s minimum interval between lastActivityAt writes per session. */
const ACTIVITY_THROTTLE_MS = 2_000;
/** Timeout to wait for natural exit during disposeAll before resolving. */
const DISPOSE_GRACE_MS = 2_500;
/**
 * Cap on the per-stream partial-line buffer. A provider emitting megabytes
 * without a newline (misbehavior or stuck stream) would otherwise grow this
 * buffer without bound. Raw bytes are still persisted via raw_outputs;
 * crossing this cap drops the partial and surfaces a marker event.
 */
const STREAM_BUFFER_CAP = 1_048_576;

const DEBUG = process.env.DEBUG_ARGMAX === "1";

export class ProviderSessionService {
  private readonly handles = new Map<string, HandleEntry>();
  private readonly buffers = new Map<string, SessionBuffer>();

  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly adapterFactory: (provider: ProviderId) => ProviderAdapter = getProviderAdapter,
    private readonly publishDelta: (delta: DashboardDelta) => void = () => undefined,
    private readonly notifications: NotificationService | null = null
  ) {}

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
    if (!DEBUG) return;
    logger.debug("providers.session", "handle count", {
      handles: this.openHandleCount,
      action,
      sessionId
    });
  }

  async launch(input: LaunchProviderSessionInput): Promise<SessionSummary> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const sessionId = randomUUID();

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
        source: "composer"
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
        ...(session.providerConversationId
          ? {
              providerConversationId: session.providerConversationId
            }
          : {})
      }
    });
    this.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [runningWorkspace],
      sessions: [session],
      events: [userMessage, sessionStarted]
    });

    this.initializeBuffer(sessionId, workspace.id, input.provider, input.modelId);
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
          cols: input.cols,
          rows: input.rows
        },
        (event) => this.handleProviderEvent(workspace.id, input.provider, event)
      );
      // If the placeholder was rejected (e.g., a concurrent launch failure path
      // ran), drop the resolved handle and terminate the freshly spawned child.
      if (pending.rejected) {
        try {
          void handle.terminate();
        } catch {
          /* ignore */
        }
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

  async sendInput(sessionId: string, input: string, modelSelection?: FollowUpModelSelection): Promise<void> {
    const message = input.replace(/\r?\n$/, "").trim();
    if (!message) {
      return;
    }

    let session = this.database.getSession(sessionId);
    const workspace = this.database.getWorkspace(session.workspaceId);
    const existingEntry = this.handles.get(sessionId);
    if (existingEntry?.kind === "pending") {
      throw new Error("Wait for the current response before sending another prompt.");
    }
    const liveHandle = this.getLiveHandle(sessionId);
    if (liveHandle) {
      if (!liveHandle.acceptsInput) {
        throw new Error("Wait for the current response before sending another prompt.");
      }
      // Collapse embedded newlines so the PTY-side CLI doesn't treat each line
      // as a separate prompt submission. The persisted user.message keeps the
      // original text — only what travels to the live PTY is sanitized.
      const ptyPayload = message.replace(/\r?\n/g, " ");
      liveHandle.sendInput(`${ptyPayload}\r`);
    }

    const userMessage = this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "user.message",
      message,
      payload: {
        source: "composer"
      }
    });
    if (liveHandle) {
      this.publishDashboardDelta({ events: [userMessage] });
      return;
    }

    if (modelSelection) {
      session = this.database.updateSessionModel(sessionId, modelSelection);
    }

    const runningSession = this.database.updateSessionState(sessionId, {
      state: "running",
      attention: computeSessionAttention({ state: "running" }),
      completedAt: null
    });
    const runningWorkspace = this.database.updateWorkspaceState(workspace.id, "running");
    this.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [runningWorkspace],
      sessions: [runningSession],
      events: [userMessage]
    });

    this.initializeBuffer(sessionId, workspace.id, session.provider, session.modelId);
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
          cols: 120,
          rows: 32
        },
        (event) => this.handleProviderEvent(workspace.id, session.provider, event)
      );
      if (pending.rejected) {
        try {
          void handle.terminate();
        } catch {
          /* ignore */
        }
        throw new Error("Provider launch was cancelled before handle registration.");
      }
      this.handles.set(sessionId, { kind: "resolved", handle });
      this.logHandleCount("reopened", sessionId);
      for (const op of pending.ops) {
        this.applyOpToHandle(handle, op);
      }
      pending.ops.length = 0;
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
    this.deleteBuffer(args.sessionId);
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
    this.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [failedWorkspace],
      sessions: [failedSession],
      events: [errorEvent]
    });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.handles.get(sessionId);
    if (!entry) {
      return;
    }
    if (entry.kind === "pending") {
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
      return;
    }
    if (entry.kind === "pending") {
      entry.cancelled = true;
      entry.rejected = true;
      entry.ops.length = 0;
      this.handles.delete(sessionId);
      this.cancelSession(sessionId);
      return;
    }
    if (entry.handle.disposed) {
      return;
    }
    // Flush any buffered partial line so the trailing fragment surfaces before
    // termination tears down the per-session state.
    this.flushTrailingFragment(sessionId);
    this.flushBatch(sessionId);
    await entry.handle.terminate();
    this.cancelSession(sessionId);
  }

  /**
   * Reconcile sessions that the database still marks `running` but for which
   * no live handle exists. Intended to run exactly once at app boot — any row
   * in this state at startup was abandoned by a previous process (crash, kill,
   * power loss). Each surviving row transitions to `cancelled` with a synthetic
   * `session.recovered-from-crash` timeline event so users see why a session
   * they expected to be live is no longer running.
   */
  /**
   * Extract and persist learning candidates from a completed session's
   * timeline. Best-effort: a failing insert (e.g. project was archived
   * mid-flight) is swallowed so the session-complete pipeline can't fail.
   */
  private bumpInjectedLearningHits(ids: readonly string[]): void {
    try {
      const now = new Date().toISOString();
      const stmt = this.database.connection.prepare(
        "UPDATE learnings SET hits = hits + 1, last_seen_at = ? WHERE id = ?"
      );
      this.database.connection.transaction(() => {
        for (const id of ids) {
          stmt.run(now, id);
        }
      })();
    } catch (error) {
      logger.warn("providers.memory", "bumpInjectedLearningHits failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private synthesizeLearnings(sessionId: string, workspaceId: string): void {
    try {
      const workspace = this.database.getWorkspace(workspaceId);
      const events = this.listAllSessionEvents(sessionId);
      const candidates = extractLearningCandidates(events);
      for (const candidate of candidates) {
        this.database.insertLearning({
          projectId: workspace.projectId,
          kind: candidate.kind,
          summary: candidate.summary,
          evidenceSessionId: candidate.evidenceSessionId,
          evidenceEventId: candidate.evidenceEventId
        });
      }
    } catch (error) {
      // Synthesizer is non-critical; log and move on.
      logger.warn("providers.memory", "synthesizeLearnings failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private listAllSessionEvents(sessionId: string): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    let eventCursor = 0;
    while (true) {
      const page = this.database.listSessionEventsSince({
        sessionId,
        eventCursor,
        rawOutputCursor: Number.MAX_SAFE_INTEGER
      });
      events.push(...page.events);
      if (page.events.length === 0 || page.eventCursor <= eventCursor) {
        return events;
      }
      eventCursor = page.eventCursor;
    }
  }

  recoverOrphanedSessions(): { recoveredCount: number } {
    const ids = this.database.listRunningSessionIds();
    if (ids.length === 0) {
      return { recoveredCount: 0 };
    }
    const completedAt = new Date().toISOString();
    const recoveredSessions = [];
    const recoveredWorkspaces = [];
    const recoveryEvents = [];
    for (const sessionId of ids) {
      try {
        const session = this.database.updateSessionState(sessionId, {
          state: "cancelled",
          attention: computeSessionAttention({ state: "cancelled" }),
          completedAt,
          lastActivityAt: completedAt
        });
        recoveredSessions.push(session);
        const workspace = this.database.updateWorkspaceState(session.workspaceId, "cancelled");
        recoveredWorkspaces.push(workspace);
        const event = this.database.persistTimelineEvent({
          id: randomUUID(),
          sessionId,
          type: "session.recovered-from-crash",
          message: "Argmax restarted while this session was still running; marking as cancelled.",
          payload: {},
          createdAt: completedAt
        });
        recoveryEvents.push(event);
      } catch (error) {
        if (error instanceof RecordNotFoundError) continue;
        throw error;
      }
    }
    if (recoveredSessions.length > 0) {
      this.publishDashboardDelta({
        projects: this.database.listProjects(),
        workspaces: recoveredWorkspaces,
        sessions: recoveredSessions,
        events: recoveryEvents
      });
    }
    return { recoveredCount: recoveredSessions.length };
  }

  private cancelSession(sessionId: string): void {
    this.flushTrailingFragment(sessionId);
    this.flushBatch(sessionId);
    const completedAt = new Date().toISOString();
    const sessionState = this.buffers.get(sessionId);
    const workspaceId = sessionState?.workspaceId ?? this.database.getSession(sessionId).workspaceId;
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
    this.deleteBuffer(sessionId);
    this.publishDashboardDelta({
      projects: this.database.listProjects(),
      workspaces: [workspace],
      sessions: [session],
      events: [event]
    });
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.handles.keys()];
    if (DEBUG && sessions.length > 0) {
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
          this.deleteBuffer(sessionId);
          return;
        }
        if (entry.handle.disposed) {
          return;
        }
        this.flushTrailingFragment(sessionId);
        this.flushBatch(sessionId);
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

  private initializeBuffer(sessionId: string, workspaceId: string, provider: ProviderId, modelId: string): void {
    this.buffers.set(sessionId, {
      streamBuffers: new Map(),
      sequence: 0,
      lastFlushAt: 0,
      flushTimer: null,
      pendingEvents: [],
      pendingRawOutputs: [],
      pendingUsages: [],
      pendingSessionUpdate: null,
      lastActivityWriteAt: 0,
      workspaceId,
      provider,
      normalizerContext: createNormalizerSessionContext(
        provider === "cursor" ? { cursorCurrentModel: modelId } : {}
      )
    });
  }

  private deleteBuffer(sessionId: string): void {
    const entry = this.buffers.get(sessionId);
    if (entry?.flushTimer) {
      clearTimeout(entry.flushTimer);
    }
    this.buffers.delete(sessionId);
  }

  private handleProviderEvent(
    workspaceId: string,
    provider: ProviderId,
    event: ProviderEvent
  ): void {
    const sessionState = this.buffers.get(event.sessionId);

    if (event.type === "output") {
      // Persist raw output (with truncation) directly into the pending batch.
      this.queueRawOutput(event);

      // Append into the per-stream line buffer for this session; only feed
      // completed lines into the normalizer. Trailing partial line is held
      // for the next chunk on the same stream.
      if (sessionState) {
        const previous = sessionState.streamBuffers.get(event.stream) ?? "";
        const combined = previous + event.message;
        const newlineIndex = combined.lastIndexOf("\n");
        if (newlineIndex >= 0) {
          const completed = combined.slice(0, newlineIndex + 1);
          sessionState.streamBuffers.set(event.stream, combined.slice(newlineIndex + 1));
          const providerConversationId = extractProviderConversationId(completed, provider);
          if (providerConversationId) {
            this.recordProviderConversationId(event.sessionId, providerConversationId);
          }
          const syntheticEvent: ProviderEvent = { ...event, message: completed };
          const normalized = normalizeProviderEventWithUsage(syntheticEvent, {
            provider,
            context: sessionState.normalizerContext
          });
          for (const ev of normalized.events) {
            this.queueTimelineEvent(event.sessionId, ev);
          }
          for (const usage of normalized.usages) {
            this.queueUsage(event.sessionId, usage);
          }
        } else if (combined.length > STREAM_BUFFER_CAP) {
          // Drop the partial-line buffer when it crosses the cap. Raw bytes
          // are already in raw_outputs; surface a marker so the chat reflects
          // the truncation rather than silently swallowing megabytes.
          const droppedBytes = combined.length;
          sessionState.streamBuffers.set(event.stream, "");
          const marker = `\n[argmax: dropped ${droppedBytes} bytes of unparseable stream output (no newline)]\n`;
          const syntheticEvent: ProviderEvent = { ...event, message: marker };
          const normalized = normalizeProviderEventWithUsage(syntheticEvent, {
            provider,
            context: sessionState.normalizerContext
          });
          for (const ev of normalized.events) {
            this.queueTimelineEvent(event.sessionId, ev);
          }
          for (const usage of normalized.usages) {
            this.queueUsage(event.sessionId, usage);
          }
        } else {
          sessionState.streamBuffers.set(event.stream, combined);
        }
        this.maybeUpdateLastActivity(event);
        this.scheduleFlush(event.sessionId);
      }
      return;
    }

    // Lifecycle event: flush any held partial line and any pending batch
    // synchronously, then update state and remove the handle.
    this.flushTrailingFragment(event.sessionId);
    this.flushBatch(event.sessionId);

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
      this.publishDashboardDelta({
        projects: this.database.listProjects(),
        workspaces: [workspace],
        sessions: [session],
        events: [timelineEvent],
        rawOutputs: [rawOutput]
      });
      if (succeeded) {
        this.synthesizeLearnings(event.sessionId, workspaceId);
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
    this.deleteBuffer(event.sessionId);
  }

  private queueRawOutput(event: ProviderEvent): void {
    const sessionState = this.buffers.get(event.sessionId);
    const { content } = capRawContent(event.message);
    const truncatedDelta = capRawTruncationMarker(event);
    const id = randomUUID();
    if (sessionState) {
      sessionState.pendingRawOutputs.push({
        id,
        sessionId: event.sessionId,
        stream: event.stream,
        content,
        createdAt: event.createdAt
      });
      if (truncatedDelta) {
        this.queueTimelineEvent(event.sessionId, truncatedDelta);
      }
    } else {
      // Defensive: persist directly when no buffer exists.
      const rawOutputInput = {
        id,
        sessionId: event.sessionId,
        stream: event.stream,
        content,
        createdAt: event.createdAt
      };
      const rawOutput = this.database.persistRawOutput(rawOutputInput);
      this.publishDashboardDelta({ rawOutputs: [rawOutput] });
      if (truncatedDelta) {
        const persisted = this.database.persistTimelineEvent(truncatedDelta);
        this.publishDashboardDelta({ events: [persisted] });
      }
    }
  }

  private queueUsage(sessionId: string, usage: NormalizedUsage): void {
    const sessionState = this.buffers.get(sessionId);
    if (sessionState) {
      sessionState.pendingUsages.push(usage);
      return;
    }
    // Defensive: no buffer (post-disposal) — write through synchronously so
    // late-arriving usage is not dropped.
    this.database.insertUsageEvent({
      sessionId,
      ...(usage.eventId ? { eventId: usage.eventId } : {}),
      modelId: usage.modelId,
      tokens: usage.tokens,
      costUsd: usage.costUsd
    });
  }

  private queueTimelineEvent(sessionId: string, event: PersistTimelineEventInput): void {
    const sessionState = this.buffers.get(sessionId);
    const { payload, sibling } = capEventPayload(event.payload, event.type);
    const stamped: PersistTimelineEventInput & { sequence?: number } = {
      ...event,
      payload
    };
    if (sessionState) {
      sessionState.sequence += 1;
      (stamped as PersistTimelineEventInput & { sequence: number }).sequence = sessionState.sequence;
      sessionState.pendingEvents.push(stamped);
      if (sibling) {
        sessionState.sequence += 1;
        const stampedSibling: PersistTimelineEventInput & { sequence: number } = {
          ...sibling,
          sessionId,
          sequence: sessionState.sequence
        };
        sessionState.pendingEvents.push(stampedSibling);
      }
    } else {
      const persisted = this.database.persistTimelineEvent(stamped);
      const events = [persisted];
      if (sibling) {
        events.push(this.database.persistTimelineEvent({ ...sibling, sessionId }));
      }
      this.publishDashboardDelta({ events });
    }
  }

  private maybeUpdateLastActivity(event: ProviderEvent): void {
    const sessionState = this.buffers.get(event.sessionId);
    if (!sessionState) {
      return;
    }
    const now = Date.parse(event.createdAt);
    if (Number.isNaN(now)) {
      return;
    }
    if (now - sessionState.lastActivityWriteAt < ACTIVITY_THROTTLE_MS) {
      return;
    }
    sessionState.lastActivityWriteAt = now;
    try {
      const session = this.database.getSession(event.sessionId);
      sessionState.pendingSessionUpdate = this.database.updateSessionState(event.sessionId, {
        state: session.state,
        attention: session.attention,
        completedAt: session.completedAt ?? null,
        lastActivityAt: event.createdAt
      });
    } catch (error) {
      if (error instanceof RecordNotFoundError && error.kind === "session") return;
      throw error;
    }
  }

  private recordProviderConversationId(sessionId: string, providerConversationId: string): void {
    try {
      const session = this.database.getSession(sessionId);
      if (session.providerConversationId === providerConversationId) {
        return;
      }
      const updated = this.database.updateSessionProviderConversationId(sessionId, providerConversationId);
      const sessionState = this.buffers.get(sessionId);
      if (sessionState) {
        sessionState.pendingSessionUpdate = updated;
        return;
      }
      this.publishDashboardDelta({ sessions: [updated] });
    } catch (error) {
      if (error instanceof RecordNotFoundError && error.kind === "session") return;
      throw error;
    }
  }

  private scheduleFlush(sessionId: string): void {
    const sessionState = this.buffers.get(sessionId);
    if (!sessionState) {
      return;
    }
    scheduleFlushQueue(sessionState, sessionId, (sid) => this.flushBatch(sid));
  }

  private flushTrailingFragment(sessionId: string): void {
    const sessionState = this.buffers.get(sessionId);
    if (!sessionState) {
      return;
    }
    for (const [stream, trailing] of sessionState.streamBuffers) {
      if (!trailing) continue;
      sessionState.streamBuffers.set(stream, "");
      // A `{`-prefixed trailing fragment is a truncated JSON line — feeding it
      // to the normalizer would surface half a JSON blob as an assistant
      // message. Persist it as a debug raw_output instead and skip the
      // timeline emission. Plain-text fragments (PTY output) still flow
      // through the normalizer.
      if (trailing.trimStart().startsWith("{") && !tryParseJsonObject(trailing.trim())) {
        this.queueRawOutput({
          sessionId,
          type: "output",
          stream: "stderr",
          message: `[argmax: dropped truncated JSON fragment (${trailing.length} bytes)]`,
          createdAt: new Date().toISOString()
        });
        continue;
      }
      const synthetic: ProviderEvent = {
        sessionId,
        type: "output",
        stream,
        message: `${trailing}\n`,
        createdAt: new Date().toISOString()
      };
      const normalized = normalizeProviderEventWithUsage(synthetic, {
        provider: sessionState.provider,
        context: sessionState.normalizerContext
      });
      for (const ev of normalized.events) {
        this.queueTimelineEvent(sessionId, ev);
      }
      for (const usage of normalized.usages) {
        this.queueUsage(sessionId, usage);
      }
    }
  }

  private flushBatch(sessionId: string): void {
    const sessionState = this.buffers.get(sessionId);
    if (!sessionState) {
      return;
    }
    flushSessionBuffer(sessionState, sessionId, this.database, (delta) => this.publishDelta(delta));
  }

  private publishDashboardDelta(delta: DashboardDelta): void {
    this.publishDelta(delta);
  }
}
