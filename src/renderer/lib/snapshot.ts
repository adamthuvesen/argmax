import type { DashboardDelta, DashboardSnapshot, PendingMessage, TimelineEvent } from "../../shared/types.js";
import { advanceTurnBoundary, isSupersededAnswerDelta, type TurnBoundary } from "./turnBoundaries.js";

export const emptySnapshot: DashboardSnapshot = {
  projects: [],
  workspaces: [],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: [],
  pendingMessages: {}
};

/**
 * Drops message.delta events that have a subsequent message.completed within
 * the same turn. A streaming response can produce hundreds of deltas; if we
 * keep them in renderer state they crowd out command.started/completed pairs
 * under the event cap, and tool calls vanish from the UI once the response
 * finishes. We still keep the latest deltas (no completion yet) so live
 * streaming continues to render.
 *
 * Events may arrive in any order; this works on either ascending or descending
 * arrays. The supersede / user.message break-out only fires when the later
 * event belongs to the same session — otherwise concurrent sessions would
 * prune each other's deltas as soon as either completed a turn.
 */
export function pruneSupersededDeltas(events: TimelineEvent[]): TimelineEvent[] {
  if (events.length < 2) return events;
  const first = events[0];
  const last = events[events.length - 1];
  const isDescending = !!first && !!last && isAfter(first, last);
  const ascending = isDescending ? [...events].reverse() : events;

  // Single right-to-left sweep: for each session, track the next turn-boundary
  // event after this position. nextBoundary reflects the closest boundary at
  // j > i because those rows were processed in earlier iterations.
  const nextBoundary = new Map<string, TurnBoundary>();
  const supersededIndices = new Set<number>();
  for (let i = ascending.length - 1; i >= 0; i--) {
    const e = ascending[i];
    if (!e) continue;
    if (e.type === "message.delta") {
      if (isSupersededAnswerDelta(e, nextBoundary.get(e.sessionId))) {
        supersededIndices.add(i);
      }
      continue;
    }
    const boundary = advanceTurnBoundary(nextBoundary.get(e.sessionId), e);
    if (boundary !== undefined) {
      nextBoundary.set(e.sessionId, boundary);
    }
  }

  if (supersededIndices.size === 0) return events;
  const kept: TimelineEvent[] = [];
  for (let i = 0; i < ascending.length; i++) {
    if (!supersededIndices.has(i)) {
      const e = ascending[i];
      if (e) kept.push(e);
    }
  }
  return isDescending ? kept.reverse() : kept;
}

// Token-by-token streaming produces hundreds of answer `message.delta` rows per
// turn, and Claude extended thinking adds hundreds more thinking `message.delta`
// rows. Capping the merged event list naively (newest-N) would let either flood
// evict the OLDEST rows — the user bubble and early tool calls — mid-stream,
// making them flicker out. We cap THREE kinds independently so a flood of one
// can never evict another:
//   - answer deltas (non-thinking message.delta): droppable, EVENT_DELTA_LIMIT
//   - thinking deltas (message.delta with payload.thinking): their own bucket,
//     EVENT_THINKING_LIMIT — kept generous so reasoning stays visible, but
//     bounded so a long thinking phase can't crowd out tool rows
//   - protected/durable rows (user/assistant messages, tool started/completed,
//     approvals, errors, completions): EVENT_PROTECTED_LIMIT, sized to hold a
//     large multi-agent turn (hundreds of tool calls) without eviction
// The current turn's rows are always the newest of their kind, so they survive.
//
// Three buckets keep answer streaming, extended thinking, and durable rows from
// evicting one another under bursty provider output.
const EVENT_DELTA_LIMIT = 500;
const EVENT_THINKING_LIMIT = 1000;
const EVENT_PROTECTED_LIMIT = 2000;

function isThinkingDelta(event: TimelineEvent): boolean {
  return event.type === "message.delta" && event.payload?.["thinking"] === true;
}

function isEvictableDelta(event: TimelineEvent): boolean {
  return event.type === "message.delta" && event.payload?.["thinking"] !== true;
}

function mergeEventsBounded(
  current: TimelineEvent[],
  updates: TimelineEvent[] | undefined
): TimelineEvent[] {
  if (!updates) {
    return current;
  }
  const merged = upsertById(current, updates);
  if (merged === current) {
    return pruneSupersededDeltas(current);
  }
  // Newest-first, same ordering mergeSlice used.
  const sorted = sortByTimestamp(merged, (event) => event.createdAt, (event) => event.rowCursor);
  let deltaKept = 0;
  let thinkingKept = 0;
  let protectedKept = 0;
  const capped = sorted.filter((event) => {
    if (isThinkingDelta(event)) {
      thinkingKept += 1;
      return thinkingKept <= EVENT_THINKING_LIMIT;
    }
    if (isEvictableDelta(event)) {
      deltaKept += 1;
      return deltaKept <= EVENT_DELTA_LIMIT;
    }
    protectedKept += 1;
    return protectedKept <= EVENT_PROTECTED_LIMIT;
  });
  return pruneSupersededDeltas(capped.length === sorted.length ? sorted : capped);
}

export function mergeDashboardDelta(snapshot: DashboardSnapshot, delta: DashboardDelta): DashboardSnapshot {
  const projects = delta.projects
    ? (() => {
        const merged = upsertById(snapshot.projects, delta.projects);
        return merged === snapshot.projects ? snapshot.projects : sortProjects(merged);
      })()
    : snapshot.projects;
  const workspaces = mergeSlice(snapshot.workspaces, delta.workspaces, (workspace) => workspace.lastActivityAt);
  const sessions = mergeSlice(snapshot.sessions, delta.sessions, (session) => session.lastActivityAt);
  const events = mergeEventsBounded(snapshot.events, delta.events);
  const rawOutputs = mergeSlice(
    snapshot.rawOutputs,
    delta.rawOutputs,
    (output) => output.createdAt,
    100,
    (output) => output.rowCursor
  );
  const approvals = mergeSlice(snapshot.approvals, delta.approvals, (approval) => approval.createdAt, 200);
  const checks = mergeSlice(snapshot.checks, delta.checks, (check) => check.startedAt, 200);
  const checkpoints = mergeSlice(snapshot.checkpoints, delta.checkpoints, (checkpoint) => checkpoint.createdAt, 200);
  const pendingMessages = mergePendingMessages(snapshot.pendingMessages, delta.pendingMessages);

  if (
    projects === snapshot.projects &&
    workspaces === snapshot.workspaces &&
    sessions === snapshot.sessions &&
    events === snapshot.events &&
    rawOutputs === snapshot.rawOutputs &&
    approvals === snapshot.approvals &&
    checks === snapshot.checks &&
    checkpoints === snapshot.checkpoints &&
    pendingMessages === snapshot.pendingMessages
  ) {
    return snapshot;
  }

  return {
    projects,
    workspaces,
    sessions,
    events,
    rawOutputs,
    approvals,
    checks,
    checkpoints,
    pendingMessages
  };
}

/**
 * Per-session full replacement. The delta carries the *new* queue contents for
 * each session key — empty array means "queue is now empty, drop the key."
 * Untouched session ids carry over unchanged.
 */
function mergePendingMessages(
  current: Record<string, PendingMessage[]> | undefined,
  updates: Record<string, PendingMessage[]> | undefined
): Record<string, PendingMessage[]> {
  const base = current ?? {};
  if (!updates) {
    return base;
  }
  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return base;
  }
  let changed = false;
  const next: Record<string, PendingMessage[]> = { ...base };
  for (const sessionId of updateKeys) {
    const incoming = updates[sessionId] ?? [];
    if (incoming.length === 0) {
      if (sessionId in next) {
        delete next[sessionId];
        changed = true;
      }
      continue;
    }
    const existing = next[sessionId];
    if (!existing || existing.length !== incoming.length) {
      next[sessionId] = incoming;
      changed = true;
      continue;
    }
    const same = existing.every((entry, index) => entry.id === incoming[index]?.id);
    if (!same) {
      next[sessionId] = incoming;
      changed = true;
    }
  }
  return changed ? next : base;
}

export function sortProjects(projects: DashboardSnapshot["projects"]): DashboardSnapshot["projects"] {
  return sortByTimestamp(projects, (project) => project.latestActivityAt ?? "");
}

function mergeSlice<T extends { id: string }>(
  current: T[],
  updates: T[] | undefined,
  sortBy: (item: T) => string,
  limit?: number,
  orderBy?: (item: T) => number | undefined
): T[] {
  if (!updates) {
    return current;
  }
  const merged = upsertById(current, updates);
  if (merged === current) {
    return current;
  }
  const sorted = sortByTimestamp(merged, sortBy, orderBy);
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  if (updates.length === 0) {
    return current;
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of updates) {
    if (byId.get(item.id) !== item) {
      changed = true;
      byId.set(item.id, item);
    }
  }
  return changed ? [...byId.values()] : current;
}

function sortByTimestamp<T>(
  items: T[],
  getTimestamp: (item: T) => string,
  getOrder?: (item: T) => number | undefined
): T[] {
  return [...items].sort((left, right) => {
    const leftOrder = getOrder?.(left);
    const rightOrder = getOrder?.(right);
    if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
      return rightOrder - leftOrder;
    }
    return getTimestamp(right).localeCompare(getTimestamp(left));
  });
}

export function mergeByCreatedAt<T extends { id: string; createdAt: string; rowCursor?: number }>(
  current: T[],
  updates: T[],
  limit: number,
  direction: "asc" | "desc"
): T[] {
  // sortByTimestamp is newest-first; take the newest `limit`, then orient.
  const newestFirst = sortByTimestamp(
    upsertById(current, updates),
    (item) => item.createdAt,
    (item) => item.rowCursor
  ).slice(0, limit);
  return direction === "asc" ? newestFirst.reverse() : newestFirst;
}

function isAfter(left: TimelineEvent, right: TimelineEvent): boolean {
  if (left.rowCursor !== undefined && right.rowCursor !== undefined) {
    return left.rowCursor > right.rowCursor;
  }
  return left.createdAt > right.createdAt;
}
