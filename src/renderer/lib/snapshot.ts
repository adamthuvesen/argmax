import type { DashboardDelta, DashboardSnapshot, TimelineEvent } from "../../shared/types.js";

export const emptySnapshot: DashboardSnapshot = {
  projects: [],
  workspaces: [],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
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
  const isDescending = !!first && !!last && first.createdAt > last.createdAt;
  const ascending = isDescending ? [...events].reverse() : events;
  const kept: TimelineEvent[] = [];
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
    if (!superseded) kept.push(event);
  }
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
    mergeSlice(snapshot.events, delta.events, (event) => event.createdAt, 500)
  );
  const rawOutputs = mergeSlice(snapshot.rawOutputs, delta.rawOutputs, (output) => output.createdAt, 100);
  const approvals = mergeSlice(snapshot.approvals, delta.approvals, (approval) => approval.createdAt, 200);
  const checks = mergeSlice(snapshot.checks, delta.checks, (check) => check.startedAt, 200);
  const checkpoints = mergeSlice(snapshot.checkpoints, delta.checkpoints, (checkpoint) => checkpoint.createdAt, 200);

  if (
    projects === snapshot.projects &&
    workspaces === snapshot.workspaces &&
    sessions === snapshot.sessions &&
    events === snapshot.events &&
    rawOutputs === snapshot.rawOutputs &&
    approvals === snapshot.approvals &&
    checks === snapshot.checks &&
    checkpoints === snapshot.checkpoints
  ) {
    return snapshot;
  }

  return { projects, workspaces, sessions, events, rawOutputs, approvals, checks, checkpoints };
}

export function sortProjects(projects: DashboardSnapshot["projects"]): DashboardSnapshot["projects"] {
  return sortByTimestamp(projects, (project) => project.latestActivityAt ?? "");
}

function mergeSlice<T extends { id: string }>(
  current: T[],
  updates: T[] | undefined,
  sortBy: (item: T) => string,
  limit?: number
): T[] {
  if (!updates) {
    return current;
  }
  const merged = upsertById(current, updates);
  if (merged === current) {
    return current;
  }
  const sorted = sortByTimestamp(merged, sortBy);
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

function sortByTimestamp<T>(items: T[], getTimestamp: (item: T) => string): T[] {
  return [...items].sort((left, right) => getTimestamp(right).localeCompare(getTimestamp(left)));
}

export function mergeByCreatedAt<T extends { id: string; createdAt: string }>(
  current: T[],
  updates: T[],
  limit: number,
  direction: "asc" | "desc"
): T[] {
  const sorted = sortByTimestamp(upsertById(current, updates), (item) => item.createdAt).reverse();
  const limited = sorted.slice(-limit);
  return direction === "asc" ? limited : limited.reverse();
}
