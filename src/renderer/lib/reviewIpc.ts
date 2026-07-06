import type {
  ChangedFileSummary,
  ReviewComparison,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult
} from "../../shared/types.js";

export type ReviewSourceKind = "workspace" | "project";

export interface ReviewTarget {
  kind: ReviewSourceKind;
  id: string;
}

export interface ReviewIpcDispatch {
  listChangedFiles: (comparison?: ReviewComparison) => Promise<ChangedFileSummary[]>;
  loadDiff: (filePath: string, comparison?: ReviewComparison) => Promise<WorkspaceDiff>;
  listFiles: () => Promise<WorkspaceFileEntry[]>;
  readFile: (filePath: string) => Promise<WorkspaceFilePreview>;
  /** Returns null when the IPC bridge is unavailable (e.g. vitest). */
  statFile: (filePath: string) => Promise<WorkspaceFileStat> | null;
  /** Returns null when the IPC bridge is unavailable. */
  writeFile: (
    filePath: string,
    content: string,
    expectedMtimeMs: number | null
  ) => Promise<WorkspaceFileWriteResult> | null;
}

/**
 * Factory that returns IPC callables already bound to a `target` (workspace
 * or project root). Centralizes the `if workspace then X else Y` branch.
 *
 * Call sites that do not yet have an active target keep using `target` as a
 * gate — `target === null` ⇒ skip the call.
 */
export function reviewIpcDispatch(target: ReviewTarget): ReviewIpcDispatch {
  const { kind, id } = target;
  // Consistent contract: async reads reject when the bridge is missing. Sync
  // flavors (`statFile`, `writeFile`) return `null` so callers can gate work
  // without catching; the editor should not show "save failed" in jsdom when
  // a test intentionally does not install a bridge.
  const noBridge = (): Promise<never> => Promise.reject(new Error("bridge unavailable"));
  return {
    listChangedFiles: (comparison) => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.review.listChangedFiles(id, comparison)
        : window.argmax.review.listChangedFilesForProject(id, comparison);
    },
    loadDiff: (filePath, comparison) => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.review.loadDiff(id, filePath, comparison)
        : window.argmax.review.loadDiffForProject(id, filePath, comparison);
    },
    listFiles: () => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.workspace.listFiles(id)
        : window.argmax.workspace.listFilesForProject(id);
    },
    readFile: (filePath) => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.workspace.readFile(id, filePath)
        : window.argmax.workspace.readFileForProject(id, filePath);
    },
    statFile: (filePath) => {
      if (!window.argmax) return null;
      return kind === "workspace"
        ? window.argmax.workspace.statFile(id, filePath)
        : window.argmax.workspace.statFileForProject(id, filePath);
    },
    writeFile: (filePath, content, expectedMtimeMs) => {
      if (!window.argmax) return null;
      return kind === "workspace"
        ? window.argmax.workspace.writeFile(id, filePath, content, expectedMtimeMs)
        : window.argmax.workspace.writeFileForProject(id, filePath, content, expectedMtimeMs);
    }
  };
}
