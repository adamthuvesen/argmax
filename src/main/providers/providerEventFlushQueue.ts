import { randomUUID } from "node:crypto";
import {
  RecordNotFoundError,
  type ArgmaxDatabase,
  type PersistApprovalInput,
  type PersistTimelineEventInput
} from "../persistence/database.js";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import type { DashboardDelta, ProviderId, SessionSummary } from "../../shared/types.js";
import {
  createNormalizerSessionContext,
  normalizeProviderEventWithUsage,
  type NormalizedUsage,
  type NormalizerSessionContext
} from "./providerEventNormalizer.js";
import {
  flushSessionBuffer,
  scheduleFlush as scheduleFlushQueue
} from "./sessionFlushQueue.js";
import {
  capEventPayload,
  capRawContent,
  capRawTruncationMarker,
  extractProviderConversationId
} from "./sessionPayloadCaps.js";
import type { ProviderEvent } from "./providerTypes.js";

/** 2 s minimum interval between lastActivityAt writes per session. */
const ACTIVITY_THROTTLE_MS = 2_000;
/**
 * Cap on the per-stream partial-line buffer. A provider emitting megabytes
 * without a newline (misbehavior or stuck stream) would otherwise grow this
 * buffer without bound. Raw bytes are still persisted via raw_outputs;
 * crossing this cap drops the partial and surfaces a marker event.
 */
const STREAM_BUFFER_CAP = 1_048_576;

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
  pendingApprovals: PersistApprovalInput[];
  pendingSessionUpdate: SessionSummary | null;
  failedFlushes: number;
  /** Latest output createdAt seen, used for throttled lastActivityAt updates. */
  lastActivityWriteAt: number;
  workspaceId: string;
  workspacePath: string;
  provider: ProviderId;
  /** Session-scoped normalizer context, e.g. most-recent Codex turn_context model. */
  normalizerContext: NormalizerSessionContext;
}

/**
 * Per-session output buffering, micro-batch SQLite writes, and dashboard
 * delta publish for provider streaming events. Lifecycle orchestration
 * (launch, terminate, follow-up queue) stays in ProviderSessionService.
 */
export class ProviderEventFlushQueue {
  private readonly buffers = new Map<string, SessionBuffer>();

  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly publishDelta: (delta: DashboardDelta) => void
  ) {}

  initializeBuffer(
    sessionId: string,
    workspaceId: string,
    workspacePath: string,
    provider: ProviderId,
    modelId: string
  ): void {
    this.buffers.set(sessionId, {
      streamBuffers: new Map(),
      sequence: 0,
      lastFlushAt: 0,
      flushTimer: null,
      pendingEvents: [],
      pendingRawOutputs: [],
      pendingUsages: [],
      pendingApprovals: [],
      pendingSessionUpdate: null,
      failedFlushes: 0,
      lastActivityWriteAt: 0,
      workspaceId,
      workspacePath,
      provider,
      normalizerContext: createNormalizerSessionContext(
        provider === "codex"
          ? { codexCurrentModel: modelId }
          : provider === "cursor"
            ? { cursorCurrentModel: modelId }
            : {}
      )
    });
  }

  deleteBuffer(sessionId: string): void {
    const entry = this.buffers.get(sessionId);
    if (entry?.flushTimer) {
      clearTimeout(entry.flushTimer);
    }
    this.buffers.delete(sessionId);
  }

  getBufferWorkspaceId(sessionId: string): string | undefined {
    return this.buffers.get(sessionId)?.workspaceId;
  }

  handleOutputEvent(provider: ProviderId, event: ProviderEvent): void {
    const sessionState = this.buffers.get(event.sessionId);

    this.queueRawOutput(event);

    if (!sessionState) {
      return;
    }

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

  flushTrailingFragment(sessionId: string): void {
    const sessionState = this.buffers.get(sessionId);
    if (!sessionState) {
      return;
    }
    const fallbackTimestamp =
      sessionState.pendingSessionUpdate?.lastActivityAt ?? new Date().toISOString();
    for (const [stream, trailing] of sessionState.streamBuffers) {
      if (!trailing) continue;
      sessionState.streamBuffers.set(stream, "");
      if (trailing.trimStart().startsWith("{") && !tryParseJsonObject(trailing.trim())) {
        this.queueRawOutput({
          sessionId,
          type: "output",
          stream: "stderr",
          message: `[argmax: dropped truncated JSON fragment (${trailing.length} bytes)]`,
          createdAt: fallbackTimestamp
        });
        continue;
      }
      const synthetic: ProviderEvent = {
        sessionId,
        type: "output",
        stream,
        message: `${trailing}\n`,
        createdAt: fallbackTimestamp
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

  flushBatch(sessionId: string): void {
    const sessionState = this.buffers.get(sessionId);
    if (!sessionState) {
      return;
    }
    flushSessionBuffer(
      sessionState,
      sessionId,
      this.database,
      (delta) => this.publishDelta(delta),
      (delayMs) => scheduleFlushQueue(sessionState, sessionId, (sid) => this.flushBatch(sid), delayMs)
    );
  }

  publishDashboardDelta(delta: DashboardDelta): void {
    this.publishDelta(delta);
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
      const approval = this.approvalFromEvent(sessionId, sessionState, stamped);
      if (approval) {
        sessionState.pendingApprovals.push(approval);
      }
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

  private approvalFromEvent(
    sessionId: string,
    sessionState: SessionBuffer,
    event: PersistTimelineEventInput
  ): PersistApprovalInput | null {
    if (event.type !== "approval.requested") {
      return null;
    }
    const command = typeof event.payload.command === "string" ? event.payload.command : event.message;
    if (!command.trim()) {
      return null;
    }
    const riskLevel =
      event.payload.riskLevel === "low" || event.payload.riskLevel === "medium" || event.payload.riskLevel === "high"
        ? event.payload.riskLevel
        : "medium";
    return {
      id: randomUUID(),
      sessionId,
      command,
      cwd: typeof event.payload.cwd === "string" && event.payload.cwd.trim() ? event.payload.cwd : sessionState.workspacePath,
      provider: sessionState.provider,
      riskLevel,
      status: "pending",
      ...(event.createdAt ? { createdAt: event.createdAt } : {})
    };
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
      sessionState.pendingSessionUpdate = this.database.updateSessionLastActivity(
        event.sessionId,
        event.createdAt
      );
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
}
