import type { WorkspaceFileEntry } from "../../shared/types.js";

export type ReviewSourceKind = "workspace" | "project";

export function listFilesFor(kind: ReviewSourceKind, id: string): Promise<WorkspaceFileEntry[]> {
  if (!window.argmax) return Promise.resolve([]);
  return window.argmax.workspace.listFiles({ kind, id });
}
