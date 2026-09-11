import type { ProjectSummary, WorkspaceSummary } from "../../shared/types.js";

/** Strip trailing slashes so repo roots compare equal. */
function normalizeCheckoutPath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * The shared workspace row that points at a project's live checkout — the cwd
 * the launcher edits and the integrated terminal should share.
 */
export function findSharedCheckoutWorkspace(
  project: ProjectSummary,
  workspaces: readonly WorkspaceSummary[]
): WorkspaceSummary | null {
  const repoPath = normalizeCheckoutPath(project.repoPath);
  let best: WorkspaceSummary | null = null;
  for (const workspace of workspaces) {
    if (workspace.projectId !== project.id) continue;
    if (!workspace.sharedWorkspace) continue;
    if (workspace.state === "archived") continue;
    if (normalizeCheckoutPath(workspace.path) !== repoPath) continue;
    if (
      !best ||
      (workspace.lastActivityAt ?? "") > (best.lastActivityAt ?? "")
    ) {
      best = workspace;
    }
  }
  return best;
}
