import { RecordNotFoundError, type ArgmaxDatabase, type PersistTimelineEventInput } from "../persistence/database.js";
import type { DashboardDelta, SessionSummary, TimelineEvent } from "../../shared/types.js";
import type { NormalizedUsage } from "./providerEventNormalizer.js";
import type { ProviderEvent } from "./providerTypes.js";

/**
 * Micro-batch window for coalescing provider events. 16 ms is approximately
 * one frame at 60 Hz — fast enough that the renderer never feels stalled,
 * slow enough that a burst of provider tokens lands in one transaction.
 */
export const MICRO_BATCH_MS = 16;

/**
 * Subset of `SessionBuffer` that the flush queue needs. The provider session
 * service owns the full buffer (stream parsing, normalizer context, workspace
 * metadata); the flush queue only cares about pending writes and the timer.
 */
export interface FlushQueueState {
  flushTimer: NodeJS.Timeout | null;
  lastFlushAt: number;
  pendingEvents: PersistTimelineEventInput[];
  pendingRawOutputs: Array<{
    id: string;
    sessionId: string;
    stream: ProviderEvent["stream"];
    content: string;
    createdAt: string;
  }>;
  pendingUsages: NormalizedUsage[];
  pendingSessionUpdate: SessionSummary | null;
}

/**
 * Schedule a trailing-edge flush for `sessionId` if one isn't already pending.
 * The timer is `.unref()`'d so a pending flush doesn't keep Node alive past
 * shutdown — the explicit terminate path handles final flushes deterministically.
 */
export function scheduleFlush(
  state: FlushQueueState,
  sessionId: string,
  runFlush: (sessionId: string) => void
): void {
  if (state.flushTimer) {
    return;
  }
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    runFlush(sessionId);
  }, MICRO_BATCH_MS);
  if (typeof state.flushTimer.unref === "function") {
    state.flushTimer.unref();
  }
}

/**
 * Drain `state`'s pending buffers in one SQLite transaction.
 *
 * Crash safety: the queue is snapshot-then-splice. We only remove items from
 * the pending arrays AFTER the transaction commits — if it throws, items stay
 * queued and the next flush retries them. The exception is the
 * "session-gone-mid-stream" race: if the session row vanished between the
 * micro-batch starting and the flush committing (workspace archive, CASCADE
 * delete, etc.), the whole batch is dropped explicitly — the renderer learns
 * about the deletion via the next status poll.
 *
 * On a successful commit the function publishes a `DashboardDelta` carrying
 * the persisted timeline events, raw outputs, and (if usage changed) a
 * re-read of the session row so cost/token totals stay live in the UI.
 */
export function flushSessionBuffer(
  state: FlushQueueState,
  sessionId: string,
  database: ArgmaxDatabase,
  publishDelta: (delta: DashboardDelta) => void
): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (
    state.pendingRawOutputs.length === 0 &&
    state.pendingEvents.length === 0 &&
    state.pendingUsages.length === 0 &&
    !state.pendingSessionUpdate
  ) {
    return;
  }

  const rawOutputs = state.pendingRawOutputs.slice();
  const events = state.pendingEvents.slice();
  const usages = state.pendingUsages.slice();
  let sessionUpdate = state.pendingSessionUpdate;
  const persistedEvents: TimelineEvent[] = [];

  const persist = database.connection.transaction(() => {
    for (const raw of rawOutputs) {
      database.persistRawOutput(raw);
    }
    for (const event of events) {
      persistedEvents.push(database.persistTimelineEvent(event));
    }
    for (const usage of usages) {
      database.insertUsageEvent({
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
      state.pendingRawOutputs.length = 0;
      state.pendingEvents.length = 0;
      state.pendingUsages.length = 0;
      state.pendingSessionUpdate = null;
      return;
    }
    throw error;
  }

  state.pendingRawOutputs.splice(0, rawOutputs.length);
  state.pendingEvents.splice(0, events.length);
  state.pendingUsages.splice(0, usages.length);
  state.pendingSessionUpdate = null;

  if (usages.length > 0) {
    try {
      sessionUpdate = database.getSession(sessionId);
    } catch (error) {
      if (!(error instanceof RecordNotFoundError && error.kind === "session")) {
        throw error;
      }
    }
  }
  state.lastFlushAt = Date.now();
  publishDelta({
    ...(sessionUpdate ? { sessions: [sessionUpdate] } : {}),
    ...(persistedEvents.length > 0 ? { events: persistedEvents } : {}),
    ...(rawOutputs.length > 0 ? { rawOutputs } : {})
  });
}

/**
 * True when an error from the flush transaction indicates the session row
 * vanished mid-stream (workspace archived, CASCADE delete). Either the typed
 * `RecordNotFoundError` from `insertUsageEvent`, or a foreign-key violation
 * from a timeline/raw-output INSERT.
 */
export function isSessionGoneError(error: unknown, sessionId: string): boolean {
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
