import { safeJsonParseArray } from "../../shared/safeJson.js";
import type { ProjectSummary, ProviderId } from "../../shared/types.js";

export const collapsedProjectsStorageKey = "argmax.sidebar.collapsedProjects";
export const projectOrderStorageKey = "argmax.sidebar.projectOrder";

export function loadCollapsedProjectIds(): Set<string> {
  return new Set(loadStringArray(collapsedProjectsStorageKey));
}

export function saveCollapsedProjectIds(projectIds: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...projectIds]));
}

export function loadProjectOrder(): string[] {
  return loadStringArray(projectOrderStorageKey);
}

export function saveProjectOrder(ids: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(ids));
}

function loadStringArray(storageKey: string): string[] {
  if (typeof window === "undefined") return [];
  return safeJsonParseArray(
    window.localStorage.getItem(storageKey),
    (value): value is string => typeof value === "string"
  );
}

export function applyProjectOrder(projects: ProjectSummary[], order: string[]): ProjectSummary[] {
  if (order.length === 0) return projects;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return (b.latestActivityAt ?? "") > (a.latestActivityAt ?? "") ? 1 : -1;
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
