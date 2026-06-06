import { logger } from "../../shared/logger.js";
import { errorMessage } from "../../shared/error.js";
import { safeJsonParseArray, safeJsonParseRecord } from "../../shared/safeJson.js";
import type { ProjectSummary, ProviderId } from "../../shared/types.js";

export const collapsedProjectsStorageKey = "argmax.sidebar.collapsedProjects";
export const expandedProjectsStorageKey = "argmax.sidebar.expandedProjects";
export const projectOrderStorageKey = "argmax.sidebar.projectOrder";
export const workspaceOrderStorageKey = "argmax.sidebar.workspaceOrder";
export const projectSortModeStorageKey = "argmax.sidebar.projectSortMode";
export const sidebarViewModeStorageKey = "argmax.sidebar.viewMode";
export const collapsedDateGroupsStorageKey = "argmax.sidebar.collapsedDateGroups";
export const expandedDateGroupsStorageKey = "argmax.sidebar.expandedDateGroups";

export const SIDEBAR_SESSION_LIMIT = 10;

export type ProjectSortMode = "recent" | "alphabetical" | "manual";

const projectSortModes: readonly ProjectSortMode[] = ["recent", "alphabetical", "manual"];

// "projects" groups sessions under their project (the default). "sessions"
// flattens every session into a single date-bucketed list, ignoring projects.
export type SidebarViewMode = "projects" | "sessions";

const sidebarViewModes: readonly SidebarViewMode[] = ["projects", "sessions"];

export function loadSidebarViewMode(): SidebarViewMode {
  if (typeof window === "undefined") return "projects";
  const raw = window.localStorage.getItem(sidebarViewModeStorageKey);
  if (raw === null) return "projects";
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string" && (sidebarViewModes as readonly string[]).includes(parsed)) {
    return parsed as SidebarViewMode;
  }
  return "projects";
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  writeStorageJson(sidebarViewModeStorageKey, mode);
}

export function loadProjectSortMode(): ProjectSortMode {
  if (typeof window === "undefined") return "recent";
  const raw = window.localStorage.getItem(projectSortModeStorageKey);
  if (raw === null) return "recent";
  // The value is a bare JSON string ("recent"); tolerate plain strings too in
  // case the key was set manually for debugging.
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string" && (projectSortModes as readonly string[]).includes(parsed)) {
    return parsed as ProjectSortMode;
  }
  return "recent";
}

export function saveProjectSortMode(mode: ProjectSortMode): void {
  writeStorageJson(projectSortModeStorageKey, mode);
}

export function loadCollapsedProjectIds(): Set<string> {
  return new Set(loadStringArray(collapsedProjectsStorageKey));
}

export function saveCollapsedProjectIds(projectIds: Set<string>): void {
  writeStorageJson(collapsedProjectsStorageKey, [...projectIds]);
}

export function loadExpandedProjectIds(): Set<string> {
  return new Set(loadStringArray(expandedProjectsStorageKey));
}

export function saveExpandedProjectIds(projectIds: Set<string>): void {
  writeStorageJson(expandedProjectsStorageKey, [...projectIds]);
}

// Date-bucket collapse/overflow state for the "sessions" view. Keyed by bucket
// key (e.g. "today", "month-2026-3"). Month keys naturally churn over time;
// stale entries are harmless. Date groups default to *expanded* (empty
// collapsed set), unlike projects which boot collapsed.
export function loadCollapsedDateGroupIds(): Set<string> {
  return new Set(loadStringArray(collapsedDateGroupsStorageKey));
}

export function saveCollapsedDateGroupIds(keys: Set<string>): void {
  writeStorageJson(collapsedDateGroupsStorageKey, [...keys]);
}

export function loadExpandedDateGroupIds(): Set<string> {
  return new Set(loadStringArray(expandedDateGroupsStorageKey));
}

export function saveExpandedDateGroupIds(keys: Set<string>): void {
  writeStorageJson(expandedDateGroupsStorageKey, [...keys]);
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
    // some browsers / Tauri webview edge cases). Log and continue — losing a
    // sidebar preference is preferable to an unhandled rejection burying
    // the click handler that triggered the write.
    logger.warn("renderer.projects", "writeStorageJson failed", {
      storageKey,
      error: errorMessage(error)
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

export interface SidebarDateGroup<T> {
  key: string;
  label: string;
  items: T[];
}

// Buckets workspaces into a Claude.ai-style date-grouped list: Today,
// Yesterday, Previous 7 Days, Previous 30 Days, then one bucket per calendar
// month. Boundaries are computed on local-midnight day diffs against `now`.
// Only non-empty groups are returned, ordered newest → oldest. `now` is a
// parameter so the bucketing stays pure and testable.
export function groupWorkspacesByDate<T extends { lastActivityAt: string }>(
  workspaces: T[],
  now: Date = new Date()
): SidebarDateGroup<T>[] {
  const sorted = [...workspaces].sort((a, b) => {
    if (a.lastActivityAt === b.lastActivityAt) return 0;
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  });

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  // Stable order is enforced by insertion order; Map preserves it.
  const groups = new Map<string, SidebarDateGroup<T>>();
  const push = (key: string, label: string, item: T): void => {
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { key, label, items: [item] });
    }
  };

  for (const workspace of sorted) {
    const ts = Date.parse(workspace.lastActivityAt);
    const activity = Number.isNaN(ts) ? now.getTime() : ts;
    const startOfActivityDay = new Date(
      new Date(activity).getFullYear(),
      new Date(activity).getMonth(),
      new Date(activity).getDate()
    ).getTime();
    const dayDiff = Math.round((startOfToday - startOfActivityDay) / dayMs);

    if (dayDiff <= 0) {
      push("today", "Today", workspace);
    } else if (dayDiff === 1) {
      push("yesterday", "Yesterday", workspace);
    } else if (dayDiff <= 7) {
      push("prev-7", "Previous 7 Days", workspace);
    } else if (dayDiff <= 30) {
      push("prev-30", "Previous 30 Days", workspace);
    } else {
      const d = new Date(activity);
      const key = `month-${d.getFullYear()}-${d.getMonth()}`;
      const sameYear = d.getFullYear() === now.getFullYear();
      const label = sameYear
        ? d.toLocaleString("en-US", { month: "long" })
        : d.toLocaleString("en-US", { month: "long", year: "numeric" });
      push(key, label, workspace);
    }
  }

  return [...groups.values()];
}

export function sortProjectsBy(
  projects: ProjectSummary[],
  mode: ProjectSortMode,
  manualOrder: string[]
): ProjectSummary[] {
  if (mode === "manual") return applyProjectOrder(projects, manualOrder);
  if (mode === "alphabetical") {
    return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  // "recent" — pass through the snapshot order (DB sorts by latest activity DESC).
  return projects;
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
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor";
  return "Claude";
}

export function repoNameFromPath(path: string | null | undefined): string | null {
  const trimmedPath = path?.replace(/\/+$/, "") ?? "";
  return trimmedPath.split("/").at(-1) || null;
}
