/**
 * User preference for where a launched agent runs: an isolated git worktree or
 * the project's current checkout.
 *
 * - `current`: run in the project's existing checkout (a shared workspace). The
 *   agent works on whatever branch is live; nothing new is created. This is the
 *   historical Argmax default and the least surprising option for a single agent.
 * - `worktree`: fork a fresh `argmax/<slug>` branch into its own `git worktree`
 *   under the project's configured worktree location, based on the live branch.
 *   Keeps the agent's changes off your checkout and lets several agents run in
 *   parallel without colliding.
 *
 * Chosen per launch from the composer and persisted to localStorage so the last
 * choice sticks. Reads tolerate missing/corrupt values by returning the default.
 */
export type WorkspaceMode = "current" | "worktree";

export const WORKSPACE_MODE_KEY = "argmax.workspaceMode";
export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "current";

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "current" || value === "worktree";
}

export function readStoredWorkspaceMode(): WorkspaceMode {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_MODE;
  const stored = window.localStorage.getItem(WORKSPACE_MODE_KEY);
  return isWorkspaceMode(stored) ? stored : DEFAULT_WORKSPACE_MODE;
}

export function writeWorkspaceMode(mode: WorkspaceMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_MODE_KEY, mode);
}

export function toggleWorkspaceMode(mode: WorkspaceMode): WorkspaceMode {
  return mode === "worktree" ? "current" : "worktree";
}
