import type { WorkspaceFileEntry } from "../../shared/types.js";

export type ReviewSourceKind = "workspace" | "project";

export function listFilesFor(kind: ReviewSourceKind, id: string): Promise<WorkspaceFileEntry[]> {
  if (!window.argmax) return Promise.resolve([]);
  return kind === "workspace"
    ? window.argmax.workspace.listFiles(id)
    : window.argmax.workspace.listFilesForProject(id);
}
