import { useSyncExternalStore } from "react";
import { SCRATCH_PROJECT_ID } from "../../shared/types.js";
import { readIdRecency, sortByIdRecency, touchIdRecency } from "./recencyList.js";

/**
 * Recency of projects the user aimed the new-chat composer at. The head of
 * the list is the next new chat's default, independent of which session is
 * on screen. Scratch is never stored: it is not a repository.
 */
export const LAUNCH_PROJECT_RECENCY_KEY = "argmax.launch.projectRecency";
const listeners = new Set<() => void>();

function subscribeLaunchProject(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function persistLaunchProjectId(projectId: string): void {
  if (projectId.length === 0 || projectId === SCRATCH_PROJECT_ID) return;
  touchIdRecency(LAUNCH_PROJECT_RECENCY_KEY, projectId);
  for (const listener of listeners) listener();
}

export function readLaunchProjectRecency(): string[] {
  return readIdRecency(LAUNCH_PROJECT_RECENCY_KEY).filter((id) => id !== SCRATCH_PROJECT_ID);
}

/** Most recently aimed-at project that still exists in `projects`. */
export function launchProjectIdFrom(projects: ReadonlyArray<{ id: string }>): string | null {
  const known = new Set(projects.map((project) => project.id));
  return readLaunchProjectRecency().find((id) => known.has(id)) ?? null;
}

/** A pick must repaint even when dashboard selection already has that id. */
export function useLaunchProjectId(projects: ReadonlyArray<{ id: string }>): string | null {
  return useSyncExternalStore(subscribeLaunchProject, () => launchProjectIdFrom(projects));
}

export function sortProjectsByLaunchRecency<T extends { id: string }>(projects: readonly T[]): T[] {
  return sortByIdRecency(projects, readLaunchProjectRecency(), (project) => project.id);
}
