import { safeJsonParseArray, safeJsonParseRecord } from "../../shared/safeJson.js";
import type { ProjectSummary, ProviderId } from "../../shared/types.js";

export const collapsedProjectsStorageKey = "argmax.sidebar.collapsedProjects";
export const projectOrderStorageKey = "argmax.sidebar.projectOrder";
export const workspaceOrderStorageKey = "argmax.sidebar.workspaceOrder";

export function loadCollapsedProjectIds(): Set<string> {
  return new Set(loadStringArray(collapsedProjectsStorageKey));
}

export function saveCollapsedProjectIds(projectIds: Set<string>): void {
  writeStorageJson(collapsedProjectsStorageKey, [...projectIds]);
}

export function loadProjectOrder(): string[] {
  return loadStringArray(projectOrderStorageKey);
}

export function saveProjectOrder(ids: string[]): void {
  writeStorageJson(projectOrderStorageKey, ids);
}

function writeStorageJson(storageKey: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch (error) {
    // QuotaExceededError (storage full) or SecurityError (private-mode in
    // some browsers / Electron edge cases). Log and continue — losing a
    // sidebar preference is preferable to an unhandled rejection burying
    // the click handler that triggered the write.
    console.warn("projects.writeStorageJson.failed", {
      storageKey,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function loadStringArray(storageKey: string): string[] {
  if (typeof window === "undefined") return [];
  return safeJsonParseArray(
    window.localStorage.getItem(storageKey),
    (value): value is string => typeof value === "string"
  );
}

// Per-project workspace order persistence. Pinned workspaces always sort first
// regardless of the manual drag order; the manual order is a tiebreaker among
// unpinned (or among pinned) sessions inside a single project group.
export function loadWorkspaceOrders(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  const parsed = safeJsonParseRecord(
    window.localStorage.getItem(workspaceOrderStorageKey),
    "projects.workspaceOrder"
  );
  const result: Record<string, string[]> = {};
  for (const [projectId, ids] of Object.entries(parsed)) {
    if (Array.isArray(ids) && ids.every((entry) => typeof entry === "string")) {
      result[projectId] = ids;
    }
  }
  return result;
}

export function saveWorkspaceOrders(orders: Record<string, string[]>): void {
  writeStorageJson(workspaceOrderStorageKey, orders);
}

export function sortWorkspaceGroup<T extends { id: string; pinned: boolean; lastActivityAt: string }>(
  workspaces: T[],
  manualOrder: string[]
): T[] {
  const rank = new Map(manualOrder.map((id, index) => [id, index]));
  return [...workspaces].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined || rb !== undefined) {
      // Anyone in the manual order beats anyone outside it; among those in
      // the order, the lower index wins.
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      if (ra !== rb) return ra - rb;
    }
    // Final tiebreak: most-recent activity first.
    if (a.lastActivityAt === b.lastActivityAt) return 0;
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  });
}

export function applyProjectOrder(projects: ProjectSummary[], order: string[]): ProjectSummary[] {
  if (order.length === 0) return projects;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    // Equal explicit rank: tiebreak by most-recent activity, descending. Return
    // 0 on equal timestamps so the comparator is symmetric (modern V8 sort is
    // stable, but a non-symmetric comparator is still technically broken).
    const av = a.latestActivityAt ?? "";
    const bv = b.latestActivityAt ?? "";
    if (av === bv) return 0;
    return av < bv ? 1 : -1;
  });
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Local agent task";
}

export function providerLabel(provider: ProviderId): string {
  return provider === "codex" ? "Codex" : "Claude";
}

export function repoNameFromPath(path: string | null | undefined): string | null {
  const trimmedPath = path?.replace(/\/+$/, "") ?? "";
  return trimmedPath.split("/").at(-1) || null;
}
