import type {
  RawProviderOutput,
  SessionEventsSinceResult,
  TimelineEvent
} from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import { emptySnapshot, mergeDashboardDelta } from "./snapshot.js";

const INACTIVE_SESSION_LIMIT = 12;
const MAX_PENDING_READS = 64;
const MAX_PENDING_VERSION_ENTRIES = 10_000;

export interface SessionTimelineSnapshot {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
}

export interface SessionTimelineReadTicket {
  readonly sessionId: string;
  readonly eventCursor: number | null;
  readonly rawOutputCursor: number | null;
  readonly changeCursor: number | null;
  readonly generation: number;
  readonly bucketIdentity: symbol;
  readonly readIdentity: symbol;
  readonly revision: number;
}

interface SessionTimelineBucket {
  identity: symbol;
  generation: number;
  revision: number;
  snapshot: SessionTimelineSnapshot;
  eventCursor: number | null;
  rawOutputCursor: number | null;
  changeCursor: number | null;
  authoritativeReadRequired: boolean;
  eventVersions: Map<string, number>;
  rawOutputVersions: Map<string, number>;
  eventDeletionVersions: Map<string, number>;
  rawOutputDeletionVersions: Map<string, number>;
  pendingReads: Map<symbol, number>;
}

type RevisionReadResult = SessionEventsSinceResult & {
  changeCursor?: number | null;
  deletedEventIds?: string[];
  deletedRawOutputIds?: string[];
  resetRequired?: boolean;
  hasMore?: boolean;
};

const EMPTY_SESSION_TIMELINE: SessionTimelineSnapshot = {
  events: [],
  rawOutputs: []
};

type SessionTimelineListener = () => void;

/**
 * Stores bounded transcript tails per session. Subscribed sessions remain
 * resident, while inactive sessions use a small least-recently-used cache.
 */
export class SessionTimelines {
  private readonly buckets = new Map<string, SessionTimelineBucket>();
  private readonly listeners = new Map<string, Set<SessionTimelineListener>>();
  private readonly inactiveSessions = new Map<string, true>();
  private nextGeneration = 1;

  get sessionCount(): number {
    return this.buckets.size;
  }

  getSnapshot(sessionId: string): SessionTimelineSnapshot {
    return this.buckets.get(sessionId)?.snapshot ?? EMPTY_SESSION_TIMELINE;
  }

  subscribedSessionIds(): string[] {
    return [...this.listeners.entries()]
      .filter(([, listeners]) => listeners.size > 0)
      .map(([sessionId]) => sessionId);
  }

  subscribe(sessionId: string, listener: SessionTimelineListener): () => void {
    let sessionListeners = this.listeners.get(sessionId);
    if (!sessionListeners) {
      sessionListeners = new Set();
      this.listeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    this.inactiveSessions.delete(sessionId);
    this.getOrCreateBucket(sessionId);

    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      this.listeners.delete(sessionId);
      if (this.buckets.has(sessionId)) {
        this.markInactive(sessionId);
      }
    };
  }

  merge(events: TimelineEvent[], rawOutputs: RawProviderOutput[]): void {
    const updates = new Map<
      string,
      { events: TimelineEvent[]; rawOutputs: RawProviderOutput[] }
    >();
    const getUpdates = (
      sessionId: string
    ): { events: TimelineEvent[]; rawOutputs: RawProviderOutput[] } => {
      let sessionUpdates = updates.get(sessionId);
      if (!sessionUpdates) {
        sessionUpdates = { events: [], rawOutputs: [] };
        updates.set(sessionId, sessionUpdates);
      }
      return sessionUpdates;
    };

    for (const event of events) {
      getUpdates(event.sessionId).events.push(event);
    }
    for (const output of rawOutputs) {
      getUpdates(output.sessionId).rawOutputs.push(output);
    }
    for (const [sessionId, sessionUpdates] of updates) {
      this.mergeInto(sessionId, sessionUpdates.events, sessionUpdates.rawOutputs);
    }
  }

  mergeAgentTail(
    sessionId: string,
    result: SessionEventsSinceResult,
    ticket?: SessionTimelineReadTicket
  ): boolean {
    if (!ticket) {
      this.mergeInto(sessionId, result.events, result.rawOutputs);
      return true;
    }
    const bucket = this.validReadBucket(sessionId, ticket);
    if (!bucket) return false;
    const events = result.events.filter(
      (event) => this.latestEventVersion(bucket, event.id) <= ticket.revision
    );
    const rawOutputs = result.rawOutputs.filter(
      (output) => this.latestRawOutputVersion(bucket, output.id) <= ticket.revision
    );
    const changed = this.mergeIntoBucket(bucket, events, rawOutputs);
    bucket.pendingReads.delete(ticket.readIdentity);
    this.compactVersions(bucket);
    if (changed) {
      this.notify(sessionId);
    }
    return true;
  }

  beginRead(sessionId: string): SessionTimelineReadTicket {
    const bucket = this.getOrCreateBucket(sessionId);
    while (bucket.pendingReads.size >= MAX_PENDING_READS) {
      const oldestRead = bucket.pendingReads.keys().next().value;
      if (oldestRead === undefined) break;
      bucket.pendingReads.delete(oldestRead);
    }
    this.compactVersions(bucket);
    const readIdentity = Symbol(sessionId);
    bucket.pendingReads.set(readIdentity, bucket.revision);
    return {
      sessionId,
      eventCursor: bucket.eventCursor,
      rawOutputCursor: bucket.rawOutputCursor,
      changeCursor: bucket.changeCursor,
      generation: bucket.generation,
      bucketIdentity: bucket.identity,
      readIdentity,
      revision: bucket.revision
    };
  }

  cancelRead(sessionId: string, ticket: SessionTimelineReadTicket): boolean {
    const bucket = this.validReadBucket(sessionId, ticket);
    if (!bucket) return false;
    bucket.pendingReads.delete(ticket.readIdentity);
    this.compactVersions(bucket);
    return true;
  }

  finishRead(
    sessionId: string,
    ticket: SessionTimelineReadTicket,
    result: RevisionReadResult
  ): boolean {
    const bucket = this.validReadBucket(sessionId, ticket);
    if (!bucket) return false;

    if (
      result.changeCursor != null &&
      bucket.changeCursor != null &&
      result.changeCursor < bucket.changeCursor &&
      ticket.changeCursor !== bucket.changeCursor
    ) {
      bucket.pendingReads.delete(ticket.readIdentity);
      this.compactVersions(bucket);
      return false;
    }

    const events = result.events.filter(
      (event) =>
        event.sessionId === sessionId &&
        this.latestEventVersion(bucket, event.id) <= ticket.revision
    );
    const rawOutputs = result.rawOutputs.filter(
      (output) =>
        output.sessionId === sessionId &&
        this.latestRawOutputVersion(bucket, output.id) <= ticket.revision
    );
    const deletedEventIds = (result.deletedEventIds ?? []).filter(
      (id) => (bucket.eventVersions.get(id) ?? 0) <= ticket.revision
    );
    const deletedRawOutputIds = (result.deletedRawOutputIds ?? []).filter(
      (id) => (bucket.rawOutputVersions.get(id) ?? 0) <= ticket.revision
    );
    const authoritative = bucket.authoritativeReadRequired || result.resetRequired === true;
    const baseEvents = authoritative
      ? bucket.snapshot.events.filter(
          (event) => this.latestEventVersion(bucket, event.id) > ticket.revision
        )
      : bucket.snapshot.events;
    const baseRawOutputs = authoritative
      ? bucket.snapshot.rawOutputs.filter(
          (output) => this.latestRawOutputVersion(bucket, output.id) > ticket.revision
        )
      : bucket.snapshot.rawOutputs;
    const changed = this.applyBucketUpdate(bucket, events, rawOutputs, {
      baseEvents,
      baseRawOutputs,
      deletedEventIds,
      deletedRawOutputIds
    });
    if (authoritative) {
      bucket.eventCursor = result.eventCursor;
      bucket.rawOutputCursor = result.rawOutputCursor;
    } else {
      bucket.eventCursor = Math.max(bucket.eventCursor ?? 0, result.eventCursor);
      bucket.rawOutputCursor = Math.max(bucket.rawOutputCursor ?? 0, result.rawOutputCursor);
    }
    if (result.changeCursor != null) {
      bucket.changeCursor = authoritative
        ? result.changeCursor
        : Math.max(bucket.changeCursor ?? 0, result.changeCursor);
    }
    bucket.authoritativeReadRequired = false;
    bucket.pendingReads.delete(ticket.readIdentity);
    this.compactVersions(bucket);
    if (changed) {
      this.notify(sessionId);
    }
    return true;
  }

  remove(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) {
      if (!this.buckets.delete(sessionId)) continue;
      this.inactiveSessions.delete(sessionId);
      this.notify(sessionId);
    }
  }

  retainSessions(allowedIds: Iterable<string>): void {
    const allowed = new Set(allowedIds);
    this.remove([...this.buckets.keys()].filter((sessionId) => !allowed.has(sessionId)));
  }

  reset(sessionIds?: Iterable<string>): void {
    const targets = sessionIds ? [...new Set(sessionIds)] : [...this.buckets.keys()];
    for (const sessionId of targets) {
      const current = this.buckets.get(sessionId);
      if (!current) continue;
      const hadContent =
        current.snapshot.events.length > 0 || current.snapshot.rawOutputs.length > 0;
      this.buckets.set(sessionId, this.createBucket());
      if (!this.isSubscribed(sessionId)) {
        this.markInactive(sessionId);
      }
      if (hadContent) {
        this.notify(sessionId);
      }
    }
  }

  invalidate(sessionIds?: Iterable<string>): void {
    const targets = sessionIds ? [...new Set(sessionIds)] : [...this.buckets.keys()];
    for (const sessionId of targets) {
      const current = this.buckets.get(sessionId);
      if (!current) continue;
      const invalidated = this.createBucket();
      invalidated.snapshot = current.snapshot;
      invalidated.authoritativeReadRequired = true;
      this.buckets.set(sessionId, invalidated);
      if (!this.isSubscribed(sessionId)) {
        this.markInactive(sessionId);
      }
    }
  }

  private createBucket(): SessionTimelineBucket {
    return {
      identity: Symbol("session-timeline"),
      generation: this.nextGeneration++,
      revision: 0,
      snapshot: EMPTY_SESSION_TIMELINE,
      eventCursor: null,
      rawOutputCursor: null,
      changeCursor: null,
      authoritativeReadRequired: false,
      eventVersions: new Map(),
      rawOutputVersions: new Map(),
      eventDeletionVersions: new Map(),
      rawOutputDeletionVersions: new Map(),
      pendingReads: new Map()
    };
  }

  private validReadBucket(
    sessionId: string,
    ticket: SessionTimelineReadTicket
  ): SessionTimelineBucket | null {
    const bucket = this.buckets.get(sessionId);
    if (
      ticket.sessionId !== sessionId ||
      !bucket ||
      bucket.identity !== ticket.bucketIdentity ||
      bucket.generation !== ticket.generation ||
      !bucket.pendingReads.has(ticket.readIdentity)
    ) {
      return null;
    }
    return bucket;
  }

  private getOrCreateBucket(sessionId: string): SessionTimelineBucket {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = this.createBucket();
      this.buckets.set(sessionId, bucket);
    }
    if (this.isSubscribed(sessionId)) {
      this.inactiveSessions.delete(sessionId);
    } else {
      this.markInactive(sessionId);
    }
    return bucket;
  }

  private markInactive(sessionId: string): void {
    this.inactiveSessions.delete(sessionId);
    this.inactiveSessions.set(sessionId, true);
    while (this.inactiveSessions.size > INACTIVE_SESSION_LIMIT) {
      const oldest = this.inactiveSessions.keys().next().value;
      if (oldest === undefined) break;
      this.inactiveSessions.delete(oldest);
      this.buckets.delete(oldest);
    }
  }

  private isSubscribed(sessionId: string): boolean {
    return (this.listeners.get(sessionId)?.size ?? 0) > 0;
  }

  private mergeInto(
    sessionId: string,
    events: TimelineEvent[],
    rawOutputs: RawProviderOutput[]
  ): void {
    const bucket = this.getOrCreateBucket(sessionId);
    if (this.mergeIntoBucket(bucket, events, rawOutputs)) {
      this.notify(sessionId);
    }
    this.compactVersions(bucket);
  }

  private mergeIntoBucket(
    bucket: SessionTimelineBucket,
    events: TimelineEvent[],
    rawOutputs: RawProviderOutput[]
  ): boolean {
    return this.applyBucketUpdate(bucket, events, rawOutputs);
  }

  private applyBucketUpdate(
    bucket: SessionTimelineBucket,
    events: TimelineEvent[],
    rawOutputs: RawProviderOutput[],
    options: {
      baseEvents?: TimelineEvent[];
      baseRawOutputs?: RawProviderOutput[];
      deletedEventIds?: string[];
      deletedRawOutputIds?: string[];
    } = {}
  ): boolean {
    const baseEvents = options.baseEvents ?? bucket.snapshot.events;
    const baseRawOutputs = options.baseRawOutputs ?? bucket.snapshot.rawOutputs;
    const deletedEventIds = new Set(options.deletedEventIds ?? []);
    const deletedRawOutputIds = new Set(options.deletedRawOutputIds ?? []);
    for (const event of events) {
      if (decodeTimelineEvent(event).traceSuperseded) {
        deletedEventIds.add(event.id);
      }
    }
    if (
      events.length === 0 &&
      rawOutputs.length === 0 &&
      deletedEventIds.size === 0 &&
      deletedRawOutputIds.size === 0 &&
      baseEvents === bucket.snapshot.events &&
      baseRawOutputs === bucket.snapshot.rawOutputs
    ) {
      return false;
    }

    const before = bucket.snapshot;
    const merged = mergeDashboardDelta(
      {
        ...emptySnapshot,
        events: baseEvents,
        rawOutputs: baseRawOutputs
      },
      { events, rawOutputs }
    );
    const mergedEvents =
      deletedEventIds.size === 0
        ? merged.events
        : merged.events.filter((event) => !deletedEventIds.has(event.id));
    const mergedRawOutputs =
      deletedRawOutputIds.size === 0
        ? merged.rawOutputs
        : merged.rawOutputs.filter((output) => !deletedRawOutputIds.has(output.id));

    bucket.revision += 1;
    const finalEventIds = new Set(mergedEvents.map((event) => event.id));
    const finalRawOutputIds = new Set(mergedRawOutputs.map((output) => output.id));
    for (const event of events) {
      if (finalEventIds.has(event.id) && !deletedEventIds.has(event.id)) {
        bucket.eventVersions.set(event.id, bucket.revision);
        bucket.eventDeletionVersions.delete(event.id);
      } else {
        bucket.eventDeletionVersions.set(event.id, bucket.revision);
        bucket.eventVersions.delete(event.id);
      }
    }
    for (const output of rawOutputs) {
      if (finalRawOutputIds.has(output.id) && !deletedRawOutputIds.has(output.id)) {
        bucket.rawOutputVersions.set(output.id, bucket.revision);
        bucket.rawOutputDeletionVersions.delete(output.id);
      } else {
        bucket.rawOutputDeletionVersions.set(output.id, bucket.revision);
        bucket.rawOutputVersions.delete(output.id);
      }
    }
    for (const event of before.events) {
      if (!finalEventIds.has(event.id)) {
        bucket.eventDeletionVersions.set(event.id, bucket.revision);
        bucket.eventVersions.delete(event.id);
      }
    }
    for (const output of before.rawOutputs) {
      if (!finalRawOutputIds.has(output.id)) {
        bucket.rawOutputDeletionVersions.set(output.id, bucket.revision);
        bucket.rawOutputVersions.delete(output.id);
      }
    }
    for (const id of deletedEventIds) {
      bucket.eventDeletionVersions.set(id, bucket.revision);
      bucket.eventVersions.delete(id);
    }
    for (const id of deletedRawOutputIds) {
      bucket.rawOutputDeletionVersions.set(id, bucket.revision);
      bucket.rawOutputVersions.delete(id);
    }
    if (
      bucket.eventVersions.size +
        bucket.rawOutputVersions.size +
        bucket.eventDeletionVersions.size +
        bucket.rawOutputDeletionVersions.size >
      MAX_PENDING_VERSION_ENTRIES
    ) {
      bucket.pendingReads.clear();
      bucket.eventVersions.clear();
      bucket.rawOutputVersions.clear();
      bucket.eventDeletionVersions.clear();
      bucket.rawOutputDeletionVersions.clear();
    }

    if (mergedEvents === before.events && mergedRawOutputs === before.rawOutputs) {
      return false;
    }
    bucket.snapshot = {
      events: mergedEvents,
      rawOutputs: mergedRawOutputs
    };
    return true;
  }

  private latestEventVersion(bucket: SessionTimelineBucket, id: string): number {
    return Math.max(
      bucket.eventVersions.get(id) ?? 0,
      bucket.eventDeletionVersions.get(id) ?? 0
    );
  }

  private latestRawOutputVersion(bucket: SessionTimelineBucket, id: string): number {
    return Math.max(
      bucket.rawOutputVersions.get(id) ?? 0,
      bucket.rawOutputDeletionVersions.get(id) ?? 0
    );
  }

  private compactVersions(bucket: SessionTimelineBucket): void {
    if (bucket.pendingReads.size === 0) {
      bucket.eventVersions.clear();
      bucket.rawOutputVersions.clear();
      bucket.eventDeletionVersions.clear();
      bucket.rawOutputDeletionVersions.clear();
      return;
    }
    const oldestReadRevision = Math.min(...bucket.pendingReads.values());
    for (const [id, revision] of bucket.eventVersions) {
      if (revision <= oldestReadRevision) bucket.eventVersions.delete(id);
    }
    for (const [id, revision] of bucket.rawOutputVersions) {
      if (revision <= oldestReadRevision) bucket.rawOutputVersions.delete(id);
    }
    for (const [id, revision] of bucket.eventDeletionVersions) {
      if (revision <= oldestReadRevision) bucket.eventDeletionVersions.delete(id);
    }
    for (const [id, revision] of bucket.rawOutputDeletionVersions) {
      if (revision <= oldestReadRevision) bucket.rawOutputDeletionVersions.delete(id);
    }
  }

  private notify(sessionId: string): void {
    const sessionListeners = this.listeners.get(sessionId);
    if (!sessionListeners) return;
    for (const listener of [...sessionListeners]) {
      listener();
    }
  }
}
