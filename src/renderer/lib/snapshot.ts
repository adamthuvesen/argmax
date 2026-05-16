import type { DashboardDelta, DashboardSnapshot, PendingMessage, TimelineEvent } from "../../shared/types.js";

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
 * arrays.
 */
export function pruneSupersededDeltas(events: TimelineEvent[]): TimelineEvent[] {
  if (events.length < 2) return events;
  const first = events[0];
  const last = events[events.length - 1];
  const isDescending = !!first && !!last && isAfter(first, last);
  const ascending = isDescending ? [...events].reverse() : events;
  const kept: TimelineEvent[] = [];
  let mutated = false;
  for (let i = 0; i < ascending.length; i++) {
    const event = ascending[i];
    if (!event) continue;
    if (event.type !== "message.delta") {
      kept.push(event);
      continue;
    }
    let superseded = false;
    for (let j = i + 1; j < ascending.length; j++) {
      const next = ascending[j];
      if (!next) break;
      if (next.type === "user.message") break;
      if (next.type === "message.completed") {
        superseded = true;
        break;
      }
    }
    if (superseded) {
      mutated = true;
    } else {
      kept.push(event);
    }
  }
  // Return the input reference when nothing was pruned so downstream identity
  // checks (mergeDashboardDelta) don't rebuild a snapshot for an unchanged
  // event list — the previous always-new-array shape forced a re-render per
  // streamed event.
  if (!mutated) return events;
  return isDescending ? kept.reverse() : kept;
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
  const events = pruneSupersededDeltas(
    mergeSlice(snapshot.events, delta.events, (event) => event.createdAt, 500, (event) => event.rowCursor)
  );
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
  const sorted = sortByTimestamp(
    upsertById(current, updates),
    (item) => item.createdAt,
    (item) => item.rowCursor
  ).reverse();
  const limited = sorted.slice(-limit);
  return direction === "asc" ? limited : limited.reverse();
}

function isAfter(left: TimelineEvent, right: TimelineEvent): boolean {
  if (left.rowCursor !== undefined && right.rowCursor !== undefined) {
    return left.rowCursor > right.rowCursor;
  }
  return left.createdAt > right.createdAt;
}
