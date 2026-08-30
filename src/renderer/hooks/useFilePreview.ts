import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFilePreview } from "../../shared/types.js";
import type { ReviewIpcDispatch } from "../lib/reviewIpc.js";
import type { ReviewSourceKind } from "../lib/reviewIpc.js";
import { errorMessage } from "../../shared/error.js";
import type {
  AsyncState,
  WorkspaceFileDirtyClosePrompt,
  WorkspaceFileSaveState,
  WorkspaceFileTab,
  WorkspaceFilesState
} from "./useReviewState.js";

interface WorkspaceFileTabState {
  path: string;
  preview: WorkspaceFilePreview | null;
  previewState: AsyncState;
  previewError: string | null;
  buffer: string | null;
  original: string | null;
  diskMtimeMs: number | null;
  externalChange: boolean;
  saveState: WorkspaceFileSaveState;
  saveError: string | null;
}

function createWorkspaceFileTab(path: string): WorkspaceFileTabState {
  return {
    path,
    preview: null,
    previewState: "idle",
    previewError: null,
    buffer: null,
    original: null,
    diskMtimeMs: null,
    externalChange: false,
    saveState: "idle",
    saveError: null
  };
}

function isWorkspaceFileTabDirty(tab: WorkspaceFileTabState | null, canEdit: boolean): boolean {
  if (!canEdit || !tab || tab.buffer === null) return false;
  return tab.buffer !== tab.original;
}

export function useFilePreview(args: {
  sourceId: string | null;
  sourceKind: ReviewSourceKind | null;
  dispatch: ReviewIpcDispatch | null;
  canEdit: boolean;
  mode: "changes" | "files";
  isPanelOpen: boolean;
  rootPath: string | null;
}): WorkspaceFilesState & { resetForSourceChange: () => void } {
  const { sourceId, sourceKind, dispatch, canEdit, mode, isPanelOpen, rootPath } = args;

  const dispatchRef = useRef<ReviewIpcDispatch | null>(dispatch);
  dispatchRef.current = dispatch;

  const [tabs, setTabs] = useState<WorkspaceFileTabState[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [dirtyClosePath, setDirtyClosePath] = useState<string | null>(null);

  const workspaceReadSeq = useRef(0);
  const workspaceReadTokens = useRef(new Map<string, number>());
  const workspaceSaveSeq = useRef(0);
  const workspaceSaveTokens = useRef(new Map<string, number>());

  // Remembers the disk content of files whose tabs were closed, so reopening
  // one is instant instead of re-reading from disk. Seeds new tabs as `ready`;
  // the external-change poll still revalidates mtime on focus, so a file edited
  // on disk after close is flagged rather than shown stale. Cleared on source
  // change.
  const previewCache = useRef(
    new Map<
      string,
      {
        preview: WorkspaceFilePreview;
        buffer: string | null;
        original: string | null;
        diskMtimeMs: number | null;
      }
    >()
  );

  const activeTab = tabs.find((tab) => tab.path === activeTabPath) ?? null;
  const activeFilePath = activeTab?.path;
  const activePreviewState = activeTab?.previewState;

  const listenerStateRef = useRef({
    sourceId: null as string | null,
    sourceKind: null as ReviewSourceKind | null,
    canEdit: false,
    workspaceFileTabs: [] as WorkspaceFileTabState[],
    workspaceActiveFilePath: null as string | null,
    workspaceActiveDiskMtimeMs: null as number | null,
    workspaceActiveExternalChange: false
  });
  listenerStateRef.current = {
    sourceId,
    sourceKind,
    canEdit,
    workspaceFileTabs: tabs,
    workspaceActiveFilePath: activeTabPath,
    workspaceActiveDiskMtimeMs: activeTab?.diskMtimeMs ?? null,
    workspaceActiveExternalChange: activeTab?.externalChange ?? false
  };

  // `workspace:stat-file` is a Rust command that takes the same DB mutex as
  // event ingestion, and `dashboard:delta` fires once per streamed chunk, so
  // the delta-driven check is throttled the way useDashboardSession throttles
  // its mid-turn status pull. The trailing timer is what keeps a write from the
  // last delta of a turn detectable without waiting for a window focus.
  const EXTERNAL_CHECK_MIN_INTERVAL_MS = 2000;
  const lastExternalCheckAtRef = useRef(0);
  const externalCheckTimerRef = useRef<number | null>(null);

  const resetForSourceChange = useCallback((): void => {
    setTabs([]);
    setActiveTabPath(null);
    setDirtyClosePath(null);
    workspaceReadTokens.current.clear();
    workspaceSaveTokens.current.clear();
    previewCache.current.clear();
  }, []);

  const updateTab = useCallback(
    (filePath: string, update: (tab: WorkspaceFileTabState) => WorkspaceFileTabState): void => {
      setTabs((current) => current.map((tab) => (tab.path === filePath ? update(tab) : tab)));
    },
    []
  );

  const loadFile = useCallback(
    (filePath: string): void => {
      const id = listenerStateRef.current.sourceId;
      const kind = listenerStateRef.current.sourceKind;
      if (!id || !kind || !window.argmax) return;
      const ipc = dispatchRef.current;
      if (!ipc) return;
      const token = ++workspaceReadSeq.current;
      workspaceReadTokens.current.set(filePath, token);
      updateTab(filePath, (tab) => ({
        ...tab,
        previewState: "loading",
        previewError: null,
        externalChange: false
      }));
      void ipc
        .readFile(filePath)
        .then((preview) => {
          if (workspaceReadTokens.current.get(filePath) !== token) return;
          updateTab(filePath, (tab) => ({
            ...tab,
            preview,
            previewState: "ready",
            previewError: null,
            buffer: preview.kind === "text" ? preview.content : null,
            original: preview.kind === "text" ? preview.content : null,
            diskMtimeMs: preview.kind === "text" ? preview.mtimeMs : null,
            externalChange: false,
            saveState: "idle",
            saveError: null
          }));
        })
        .catch((error) => {
          if (workspaceReadTokens.current.get(filePath) !== token) return;
          updateTab(filePath, (tab) => ({
            ...tab,
            preview: null,
            previewState: "error",
            previewError: errorMessage(error) || "Could not read file.",
            buffer: null,
            original: null,
            diskMtimeMs: null
          }));
        });
    },
    [updateTab]
  );

  useEffect(() => {
    if (mode !== "files" || !isPanelOpen) return;
    if (!sourceId || !sourceKind || !window.argmax) return;
    if (!activeFilePath || activePreviewState !== "idle") return;
    loadFile(activeFilePath);
  }, [mode, isPanelOpen, sourceId, sourceKind, activeFilePath, activePreviewState, loadFile]);

  const openFile = useCallback((filePath: string): void => {
    setTabs((current) => {
      if (current.some((tab) => tab.path === filePath)) return current;
      const cached = previewCache.current.get(filePath);
      const tab = cached
        ? {
            ...createWorkspaceFileTab(filePath),
            preview: cached.preview,
            previewState: "ready" as AsyncState,
            buffer: cached.buffer,
            original: cached.original,
            diskMtimeMs: cached.diskMtimeMs
          }
        : createWorkspaceFileTab(filePath);
      return [...current, tab];
    });
    setActiveTabPath(filePath);
    setDirtyClosePath(null);
  }, []);

  const selectTab = useCallback((filePath: string): void => {
    if (!listenerStateRef.current.workspaceFileTabs.some((tab) => tab.path === filePath)) return;
    setActiveTabPath(filePath);
    setDirtyClosePath(null);
  }, []);

  const forceCloseTab = useCallback((filePath: string): void => {
    const current = listenerStateRef.current.workspaceFileTabs;
    const index = current.findIndex((tab) => tab.path === filePath);
    if (index < 0) return;
    // Remember the on-disk content so reopening this file is instant. Cache the
    // saved `original`, never a dirty buffer — by the time a tab force-closes it
    // was either saved (original updated) or discarded.
    const closing = current[index];
    if (closing && closing.previewState === "ready" && closing.preview) {
      previewCache.current.set(filePath, {
        preview: closing.preview,
        buffer: closing.original,
        original: closing.original,
        diskMtimeMs: closing.diskMtimeMs
      });
    }
    const remaining = current.filter((tab) => tab.path !== filePath);
    const fallbackPath = remaining[index]?.path ?? remaining[index - 1]?.path ?? null;
    setTabs(remaining);
    setActiveTabPath((activePath) => {
      if (activePath && activePath !== filePath && remaining.some((tab) => tab.path === activePath)) {
        return activePath;
      }
      return fallbackPath;
    });
    setDirtyClosePath((promptPath) => (promptPath === filePath ? null : promptPath));
    workspaceReadTokens.current.delete(filePath);
    workspaceSaveTokens.current.delete(filePath);
  }, []);

  const closeTab = useCallback(
    (filePath: string): void => {
      const tab =
        listenerStateRef.current.workspaceFileTabs.find((candidate) => candidate.path === filePath) ?? null;
      if (!tab) return;
      if (isWorkspaceFileTabDirty(tab, listenerStateRef.current.canEdit)) {
        setActiveTabPath(filePath);
        setDirtyClosePath(filePath);
        return;
      }
      forceCloseTab(filePath);
    },
    [forceCloseTab]
  );

  const editFile = useCallback(
    (content: string): void => {
      if (!listenerStateRef.current.canEdit) return;
      const filePath = listenerStateRef.current.workspaceActiveFilePath;
      if (!filePath) return;
      updateTab(filePath, (tab) => ({
        ...tab,
        buffer: content,
        saveError: null,
        saveState: "idle"
      }));
    },
    [updateTab]
  );

  const reloadFile = useCallback((): void => {
    const filePath = listenerStateRef.current.workspaceActiveFilePath;
    if (!filePath) return;
    loadFile(filePath);
  }, [loadFile]);

  const dismissExternalChange = useCallback((): void => {
    const id = listenerStateRef.current.sourceId;
    const kind = listenerStateRef.current.sourceKind;
    const filePath = listenerStateRef.current.workspaceActiveFilePath;
    if (!id || !kind || !filePath) return;
    const ipc = dispatchRef.current;
    const statPromise = ipc?.statFile(filePath);
    if (!statPromise) {
      updateTab(filePath, (tab) => ({ ...tab, externalChange: false }));
      return;
    }
    void statPromise
      .then((latest) => {
        updateTab(filePath, (tab) => ({
          ...tab,
          diskMtimeMs: latest.mtimeMs,
          externalChange: false
        }));
      })
      .catch(() => {
        updateTab(filePath, (tab) => ({ ...tab, externalChange: false }));
      });
  }, [updateTab]);

  const saveFilePath = useCallback(
    async (filePath: string): Promise<"saved" | "stale" | "aborted" | "error"> => {
      const id = listenerStateRef.current.sourceId;
      const kind = listenerStateRef.current.sourceKind;
      const tab =
        listenerStateRef.current.workspaceFileTabs.find((candidate) => candidate.path === filePath) ?? null;
      if (!id || !kind || !tab || !listenerStateRef.current.canEdit) return "aborted";
      if (tab.buffer === null || tab.buffer === tab.original) return "saved";
      const contentToSave = tab.buffer;
      const token = ++workspaceSaveSeq.current;
      workspaceSaveTokens.current.set(filePath, token);
      updateTab(filePath, (current) => ({
        ...current,
        saveState: "saving",
        saveError: null
      }));
      try {
        const ipc = dispatchRef.current;
        const writePromise = ipc?.writeFile(filePath, contentToSave, tab.diskMtimeMs);
        if (!writePromise) {
          updateTab(filePath, (current) => ({ ...current, saveState: "idle" }));
          return "saved";
        }
        const result = await writePromise;
        if (workspaceSaveTokens.current.get(filePath) !== token) return "aborted";
        if (result.ok === "false") {
          updateTab(filePath, (current) => ({
            ...current,
            saveState: "idle",
            externalChange: true
          }));
          return "stale";
        }
        updateTab(filePath, (current) => ({
          ...current,
          original: contentToSave,
          diskMtimeMs: result.mtimeMs,
          saveState: "idle",
          saveError: null,
          externalChange: false
        }));
        return "saved";
      } catch (error) {
        if (workspaceSaveTokens.current.get(filePath) !== token) return "aborted";
        updateTab(filePath, (current) => ({
          ...current,
          saveState: "error",
          saveError: errorMessage(error) || "Could not save file."
        }));
        return "error";
      }
    },
    [updateTab]
  );

  const saveFile = useCallback(async (): Promise<void> => {
    const filePath = listenerStateRef.current.workspaceActiveFilePath;
    if (!filePath) return;
    await saveFilePath(filePath);
  }, [saveFilePath]);

  const saveDirtyTabAndClose = useCallback(async (): Promise<void> => {
    const filePath = dirtyClosePath;
    if (!filePath) return;
    setActiveTabPath(filePath);
    const outcome = await saveFilePath(filePath);
    if (outcome === "saved") {
      forceCloseTab(filePath);
      return;
    }
    // A write error keeps the prompt open with the tab's saveError in it —
    // dismissing would read as a silent success while the close never ran. A
    // stale file hands the conflict to the on-disk banner instead: the prompt
    // would only compete with it.
    if (outcome !== "error") setDirtyClosePath(null);
  }, [forceCloseTab, saveFilePath, dirtyClosePath]);

  const discardDirtyTabAndClose = useCallback((): void => {
    const filePath = dirtyClosePath;
    if (!filePath) return;
    forceCloseTab(filePath);
  }, [forceCloseTab, dirtyClosePath]);

  const cancelDirtyTabClose = useCallback((): void => {
    setDirtyClosePath(null);
  }, []);

  const checkActiveFileExternalChange = useCallback((): void => {
    const id = listenerStateRef.current.sourceId;
    const kind = listenerStateRef.current.sourceKind;
    const filePath = listenerStateRef.current.workspaceActiveFilePath;
    const baseline = listenerStateRef.current.workspaceActiveDiskMtimeMs;
    if (!id || !kind || !filePath || baseline === null) return;
    // The banner is already up and the baseline only advances on reload, save,
    // or dismiss — another stat can learn nothing, and every resolved stat
    // re-allocates the tab array and re-renders the pane.
    if (listenerStateRef.current.workspaceActiveExternalChange) return;
    const ipc = dispatchRef.current;
    const statPromise = ipc?.statFile(filePath);
    if (!statPromise) return;
    void statPromise
      .then((latest) => {
        if (latest.mtimeMs > baseline) {
          updateTab(filePath, (tab) => ({ ...tab, externalChange: true }));
        }
      })
      .catch(() => {
        // Stat failures during polling are non-fatal — the next save will
        // surface a real error if the file is genuinely gone.
      });
  }, [updateTab]);

  useEffect(() => {
    if (mode !== "files" || !canEdit || !isPanelOpen) return;
    const runCheck = (): void => {
      lastExternalCheckAtRef.current = Date.now();
      checkActiveFileExternalChange();
    };
    window.addEventListener("focus", runCheck);
    const offDelta = window.argmax?.dashboard?.onDelta?.(() => {
      if (externalCheckTimerRef.current !== null) return;
      const elapsed = Date.now() - lastExternalCheckAtRef.current;
      if (elapsed >= EXTERNAL_CHECK_MIN_INTERVAL_MS) {
        runCheck();
        return;
      }
      externalCheckTimerRef.current = window.setTimeout(() => {
        externalCheckTimerRef.current = null;
        runCheck();
      }, EXTERNAL_CHECK_MIN_INTERVAL_MS - elapsed);
    });
    return () => {
      window.removeEventListener("focus", runCheck);
      offDelta?.();
      if (externalCheckTimerRef.current !== null) {
        window.clearTimeout(externalCheckTimerRef.current);
        externalCheckTimerRef.current = null;
      }
    };
  }, [mode, canEdit, isPanelOpen, checkActiveFileExternalChange]);

  // Also revalidates on reopen, so a file edited on disk while the panel was
  // closed is flagged instead of shown stale.
  useEffect(() => {
    if (mode !== "files" || !canEdit || !isPanelOpen) return;
    lastExternalCheckAtRef.current = Date.now();
    checkActiveFileExternalChange();
  }, [mode, canEdit, isPanelOpen, activeTabPath, checkActiveFileExternalChange]);

  const tabSummaries: WorkspaceFileTab[] = tabs.map((tab) => ({
    path: tab.path,
    isDirty: isWorkspaceFileTabDirty(tab, canEdit),
    saveState: tab.saveState,
    externalChange: tab.externalChange
  }));

  const dirtyCloseTab =
    dirtyClosePath !== null ? tabs.find((tab) => tab.path === dirtyClosePath) ?? null : null;
  const dirtyClosePrompt: WorkspaceFileDirtyClosePrompt | null =
    dirtyCloseTab && isWorkspaceFileTabDirty(dirtyCloseTab, canEdit)
      ? { path: dirtyCloseTab.path, saveError: dirtyCloseTab.saveError }
      : null;

  return {
    entries: [],
    listState: "idle",
    listError: null,
    tabs: tabSummaries,
    activeTabPath: activeTab?.path ?? null,
    selectedPath: activeTab?.path ?? null,
    rootPath,
    preview: activeTab?.preview ?? null,
    previewState: activeTab?.previewState ?? "idle",
    previewError: activeTab?.previewError ?? null,
    openFile,
    selectTab,
    closeTab,
    dirtyClosePrompt,
    saveDirtyTabAndClose,
    discardDirtyTabAndClose,
    cancelDirtyTabClose,
    buffer: activeTab?.buffer ?? null,
    isDirty: isWorkspaceFileTabDirty(activeTab, canEdit),
    diskMtimeMs: activeTab?.diskMtimeMs ?? null,
    externalChange: activeTab?.externalChange ?? false,
    saveState: activeTab?.saveState ?? "idle",
    saveError: activeTab?.saveError ?? null,
    canEdit,
    editFile,
    saveFile,
    reloadFile,
    dismissExternalChange,
    resetForSourceChange
  };
}
