import type {
  ChangedFileSummary,
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
  listChangedFiles: () => Promise<ChangedFileSummary[]>;
  loadDiff: (filePath: string) => Promise<WorkspaceDiff>;
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
 * or project root). Centralizes the `if workspace then X else Y` branch that
 * was previously repeated across six free functions in `useReviewState`.
 *
 * Call sites that do not yet have an active target keep using `target` as a
 * gate — `target === null` ⇒ skip the call.
 */
export function reviewIpcDispatch(target: ReviewTarget): ReviewIpcDispatch {
  const { kind, id } = target;
  // Consistent contract: every async method *rejects* when the bridge is
  // missing instead of resolving with an empty default. The list flavors
  // previously resolved `[]` while the diff/read flavors rejected, which
  // made jsdom callers that forget to mock get silent empty lists from one
  // call and visible errors from another. Sync flavors (`statFile`,
  // `writeFile`) keep returning `null` so callers can gate the work without
  // catching — the editor never wants to hit "save failed" because vitest
  // didn't install a bridge.
  const noBridge = (): Promise<never> => Promise.reject(new Error("bridge unavailable"));
  return {
    listChangedFiles: () => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.review.listChangedFiles(id)
        : window.argmax.review.listChangedFilesForProject(id);
    },
    loadDiff: (filePath) => {
      if (!window.argmax) return noBridge();
      return kind === "workspace"
        ? window.argmax.review.loadDiff(id, filePath)
        : window.argmax.review.loadDiffForProject(id, filePath);
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
