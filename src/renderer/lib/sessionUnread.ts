import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * When the user last looked at each sidebar chat, keyed by workspace id.
 *
 * A row is unread when `lastActivityAt` has moved past that stamp and the
 * chat is not the one on screen. First sight of a workspace seeds the stamp
 * to its current activity so existing history does not light up when the
 * feature ships. Opening the chat (or watching it while it runs) advances
 * the stamp to the activity being shown.
 */
export const SESSION_VIEWED_STORAGE_KEY = "argmax.sidebar.viewedAt";

type ViewedMap = Record<string, string>;

const listeners = new Set<() => void>();
let loaded = false;
let viewed: ViewedMap = {};
let generation = 0;

function readStoredViewed(): ViewedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SESSION_VIEWED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: ViewedMap = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (id.length > 0 && typeof at === "string" && at.length > 0) next[id] = at;
    }
    return next;
  } catch {
    return {};
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  viewed = readStoredViewed();
}

function mapsEqual(left: ViewedMap, right: ViewedMap): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((id) => left[id] === right[id]);
}

function persist(next: ViewedMap): void {
  ensureLoaded();
  if (mapsEqual(viewed, next)) return;
  viewed = next;
  generation += 1;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SESSION_VIEWED_STORAGE_KEY, JSON.stringify(viewed));
    } catch {
      // Quota or private-mode failures are non-fatal for a reading stamp.
    }
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function generationSnapshot(): number {
  ensureLoaded();
  return generation;
}

export type WorkspaceActivity = {
  id: string;
  lastActivityAt: string;
};

/**
 * Seed unseen workspaces and stamp the open chat to the activity it is
 * showing. Drops stamps for workspaces that have left the snapshot.
 */
export function syncWorkspaceViewed(
  workspaces: ReadonlyArray<WorkspaceActivity>,
  selectedWorkspaceId: string | null
): void {
  ensureLoaded();
  const live = new Set(workspaces.map((workspace) => workspace.id));
  const next: ViewedMap = {};
  for (const [id, at] of Object.entries(viewed)) {
    if (live.has(id)) next[id] = at;
  }
  for (const workspace of workspaces) {
    if (next[workspace.id] == null || workspace.id === selectedWorkspaceId) {
      next[workspace.id] = workspace.lastActivityAt;
    }
  }
  persist(next);
}

export function workspaceHasUnreadResponse(
  workspace: WorkspaceActivity,
  options: { selectedWorkspaceId: string | null; working: boolean }
): boolean {
  if (options.working || workspace.id === options.selectedWorkspaceId) return false;
  ensureLoaded();
  const viewedAt = viewed[workspace.id];
  if (!viewedAt) return false;
  const activity = Date.parse(workspace.lastActivityAt);
  const seen = Date.parse(viewedAt);
  if (!Number.isFinite(activity) || !Number.isFinite(seen)) return false;
  return activity > seen;
}

/** Ids whose latest activity the user has not opened yet. */
export function useUnreadWorkspaceIds(
  workspaces: ReadonlyArray<WorkspaceActivity>,
  selectedWorkspaceId: string | null,
  workingIds: ReadonlySet<string>
): Set<string> {
  const gen = useSyncExternalStore(subscribe, generationSnapshot, generationSnapshot);
  useEffect(() => {
    syncWorkspaceViewed(workspaces, selectedWorkspaceId);
  }, [workspaces, selectedWorkspaceId]);
  return useMemo(() => {
    const unread = new Set<string>();
    for (const workspace of workspaces) {
      if (
        workspaceHasUnreadResponse(workspace, {
          selectedWorkspaceId,
          working: workingIds.has(workspace.id)
        })
      ) {
        unread.add(workspace.id);
      }
    }
    return unread;
  }, [gen, selectedWorkspaceId, workingIds, workspaces]);
}

/** Re-reads storage so a test can seed or clear stamps before rendering. */
export function resetSessionUnreadForTests(): void {
  loaded = false;
  viewed = {};
  generation = 0;
  for (const listener of listeners) listener();
}
