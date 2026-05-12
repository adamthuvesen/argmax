import { randomUUID } from "node:crypto";
import { RecordNotFoundError, type ArgmaxDatabase, type PersistTimelineEventInput } from "../persistence/database.js";
import { computeSessionAttention } from "../sessions/sessionAttention.js";
import { PROVIDER_MODEL_DEFAULTS, type ReasoningEffort } from "../../shared/providerModels.js";
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

/** 16 ms micro-batch coalescing window — one frame at 60Hz. */
const MICRO_BATCH_MS = 16;
/** 2 s minimum interval between lastActivityAt writes per session. */
const ACTIVITY_THROTTLE_MS = 2_000;
/** 256 KB cap on raw_outputs.content per row. */
const RAW_OUTPUT_CAP = 256 * 1024;
/** 64 KB cap on per-event payload_json. */
const EVENT_PAYLOAD_CAP = 64 * 1024;
/** 4 KB preview window in truncated payload markers. */
const EVENT_PAYLOAD_PREVIEW = 4 * 1024;
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
    console.log(`[argmax] handles: ${this.openHandleCount} (${action} ${sessionId})`);
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

    this.initializeBuffer(sessionId, workspace.id, input.provider);
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

    this.initializeBuffer(sessionId, workspace.id, session.provider);
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
          // Follow-ups inherit the current default permission mode. Stage 2
          // (P3.02) will read the per-session value from the sessions row
          // once it's persisted there.
          permissionMode: "auto-approve",
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
      console.warn("[argmax] bumpInjectedLearningHits failed:", error instanceof Error ? error.message : error);
    }
  }

  private synthesizeLearnings(sessionId: string, workspaceId: string): void {
    try {
      const workspace = this.database.getWorkspace(workspaceId);
      const { events } = this.database.listSessionEventsSince({ sessionId });
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
      console.warn("[argmax] synthesizeLearnings failed:", error instanceof Error ? error.message : error);
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
      console.log(`[argmax] disposeAll: terminating ${sessions.length} handle(s)`);
    }
    await Promise.allSettled(
      sessions.map(async (sessionId) => {
        const entry = this.handles.get(sessionId);
        if (!entry) {
          return;
        }
        if (entry.kind === "pending") {
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

  private initializeBuffer(sessionId: string, workspaceId: string, provider: ProviderId): void {
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
      normalizerContext: createNormalizerSessionContext()
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
      const rawOutput = {
        id: randomUUID(),
        sessionId: event.sessionId,
        stream: event.stream,
        content: capRawContent(event.message).content,
        createdAt: event.createdAt
      };
      this.database.persistRawOutput(rawOutput);
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
      const rawOutput = {
        id,
        sessionId: event.sessionId,
        stream: event.stream,
        content,
        createdAt: event.createdAt
      };
      this.database.persistRawOutput(rawOutput);
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
    if (sessionState.flushTimer) {
      return;
    }
    sessionState.flushTimer = setTimeout(() => {
      sessionState.flushTimer = null;
      this.flushBatch(sessionId);
    }, MICRO_BATCH_MS);
    // Allow Node.js process to exit even when the timer is pending.
    if (typeof sessionState.flushTimer.unref === "function") {
      sessionState.flushTimer.unref();
    }
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
    if (sessionState.flushTimer) {
      clearTimeout(sessionState.flushTimer);
      sessionState.flushTimer = null;
    }
    if (
      sessionState.pendingRawOutputs.length === 0 &&
      sessionState.pendingEvents.length === 0 &&
      sessionState.pendingUsages.length === 0 &&
      !sessionState.pendingSessionUpdate
    ) {
      return;
    }

    // Snapshot the pending buffers without draining them. We only splice them
    // off after the transaction commits — if it throws, the items stay in the
    // buffer (transient errors retry on the next flush; session-deleted races
    // are detected below and the batch is dropped explicitly).
    const rawOutputs = sessionState.pendingRawOutputs.slice();
    const events = sessionState.pendingEvents.slice();
    const usages = sessionState.pendingUsages.slice();
    let sessionUpdate = sessionState.pendingSessionUpdate;
    const persistedEvents: TimelineEvent[] = [];

    const persist = this.database.connection.transaction(() => {
      for (const raw of rawOutputs) {
        this.database.persistRawOutput(raw);
      }
      for (const event of events) {
        persistedEvents.push(this.database.persistTimelineEvent(event));
      }
      for (const usage of usages) {
        this.database.insertUsageEvent({
          sessionId,
          ...(usage.eventId ? { eventId: usage.eventId } : {}),
          modelId: usage.modelId,
          tokens: usage.tokens,
          costUsd: usage.costUsd
        });
      }
    });
    try {
      persist();
    } catch (error) {
      if (isSessionGoneError(error, sessionId)) {
        // Session was deleted mid-stream. Drop the whole batch — the renderer
        // will pick up the deletion via the next status poll.
        sessionState.pendingRawOutputs.length = 0;
        sessionState.pendingEvents.length = 0;
        sessionState.pendingUsages.length = 0;
        sessionState.pendingSessionUpdate = null;
        return;
      }
      throw error;
    }

    sessionState.pendingRawOutputs.splice(0, rawOutputs.length);
    sessionState.pendingEvents.splice(0, events.length);
    sessionState.pendingUsages.splice(0, usages.length);
    sessionState.pendingSessionUpdate = null;

    if (usages.length > 0) {
      try {
        sessionUpdate = this.database.getSession(sessionId);
      } catch (error) {
        if (!(error instanceof RecordNotFoundError && error.kind === "session")) {
          throw error;
        }
      }
    }
    sessionState.lastFlushAt = Date.now();
    this.publishDashboardDelta({
      ...(sessionUpdate ? { sessions: [sessionUpdate] } : {}),
      ...(persistedEvents.length > 0 ? { events: persistedEvents } : {}),
      ...(rawOutputs.length > 0 ? { rawOutputs } : {})
    });
  }

  private publishDashboardDelta(delta: DashboardDelta): void {
    this.publishDelta(delta);
  }
}

/**
 * True when an error from the flush transaction indicates the session row
 * vanished mid-stream (workspace archived, CASCADE delete). Either the typed
 * `RecordNotFoundError` from `insertUsageEvent`, or a foreign-key violation
 * from a timeline/raw-output INSERT.
 */
function isSessionGoneError(error: unknown, sessionId: string): boolean {
  if (error instanceof RecordNotFoundError && error.kind === "session" && error.id === sessionId) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  ) {
    return true;
  }
  return false;
}

function capRawContent(content: string): { content: string; droppedBytes: number } {
  if (content.length <= RAW_OUTPUT_CAP) {
    return { content, droppedBytes: 0 };
  }
  const droppedBytes = content.length - RAW_OUTPUT_CAP;
  return {
    content: `${content.slice(0, RAW_OUTPUT_CAP)}[truncated ${droppedBytes} bytes]`,
    droppedBytes
  };
}

function capRawTruncationMarker(event: ProviderEvent): PersistTimelineEventInput | null {
  if (event.message.length <= RAW_OUTPUT_CAP) {
    return null;
  }
  const droppedBytes = event.message.length - RAW_OUTPUT_CAP;
  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: "message.delta",
    message: `Output truncated: ${droppedBytes} bytes dropped`,
    payload: {
      truncated: true,
      droppedBytes,
      stream: event.stream
    },
    createdAt: event.createdAt
  };
}

function extractProviderConversationId(content: string, provider: ProviderId): string | null {
  if (provider !== "codex") {
    return null;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const record = tryParseJsonObject(rawLine.trim());
    if (!record) {
      continue;
    }
    if (record.type === "thread.started" && typeof record.thread_id === "string" && record.thread_id.length > 0) {
      return record.thread_id;
    }
  }

  return null;
}

interface CappedPayload {
  payload: Record<string, unknown>;
  sibling: Omit<PersistTimelineEventInput, "sessionId"> | null;
}

// Keys that must survive truncation so downstream consumers (renderer, tests)
// can still reconcile state. For command.completed especially: without
// tool_use_id/id the renderer can't match the result back to its
// command.started event, and the tool call hangs in "running" forever.
const STRUCTURAL_KEYS_BY_TYPE: Partial<Record<string, readonly string[]>> = {
  "command.started": ["id", "call_id", "tool_use_id", "name", "type"],
  "command.completed": [
    "id",
    "call_id",
    "tool_use_id",
    "name",
    "type",
    "is_error",
    "isError",
    "status"
  ]
};

function capEventPayload(
  payload: Record<string, unknown>,
  eventType?: string
): CappedPayload {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { payload: { truncated: true, originalSize: 0, preview: "" }, sibling: null };
  }
  if (serialized.length <= EVENT_PAYLOAD_CAP) {
    return { payload, sibling: null };
  }
  const truncatedEventId = randomUUID();
  const preserved: Record<string, unknown> = {};
  const preserveKeys = (eventType && STRUCTURAL_KEYS_BY_TYPE[eventType]) ?? [];
  for (const key of preserveKeys) {
    if (key in payload) preserved[key] = payload[key];
  }
  return {
    payload: {
      ...preserved,
      truncated: true,
      originalSize: serialized.length,
      preview: serialized.slice(0, EVENT_PAYLOAD_PREVIEW),
      truncatedEventId
    },
    sibling: {
      id: randomUUID(),
      type: "error",
      message: "event payload truncated",
      payload: {
        truncatedEventId,
        originalSize: serialized.length
      }
    }
  };
}
