import type {
  ChangedFileSummary,
  ReviewComparison,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult,
  WorkspaceTarget
} from "../../shared/types.js";

export type ReviewTarget = WorkspaceTarget;
export type ReviewSourceKind = WorkspaceTarget["kind"];

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
 * Factory that returns IPC callables already bound to a workspace/project target.
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
      return window.argmax.review.listChangedFiles({ kind, id }, comparison);
    },
    loadDiff: (filePath, comparison) => {
      if (!window.argmax) return noBridge();
      return window.argmax.review.loadDiff({ kind, id }, filePath, comparison);
    },
    listFiles: () => {
      if (!window.argmax) return noBridge();
      return window.argmax.workspace.listFiles({ kind, id });
    },
    readFile: (filePath) => {
      if (!window.argmax) return noBridge();
      return window.argmax.workspace.readFile({ kind, id }, filePath);
    },
    statFile: (filePath) => {
      if (!window.argmax) return null;
      return window.argmax.workspace.statFile({ kind, id }, filePath);
    },
    writeFile: (filePath, content, expectedMtimeMs) => {
      if (!window.argmax) return null;
      return window.argmax.workspace.writeFile({ kind, id }, filePath, content, expectedMtimeMs);
    }
  };
}
