import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ArgmaxApi, DashboardSnapshot, DetectedIde, IdeId, WorkspaceSummary } from "../../shared/types.js";
import { mergeDashboardDelta } from "../lib/snapshot.js";
import { withToast } from "../lib/withToast.js";
import { prunePaneGrid } from "../state/paneGrid.js";
import { showErrorToast, showInfoToast, showToast } from "../state/toast.js";

interface WorkspaceActions {
  refreshDashboardStatus: () => Promise<unknown>;
  workspacesById: Map<string, WorkspaceSummary>;
  selectedWorkspaceId: string | null;
  setSelectedWorkspaceId: (id: string | null) => void;
  setSelectedSessionId: (id: string | null) => void;
  setSnapshot: Dispatch<SetStateAction<DashboardSnapshot>>;
  detectedIdes: DetectedIde[];
  setDefaultIde: (ide: IdeId) => void;
}

/** Owns workspace mutations and applies their resulting dashboard selection. */
export function useWorkspaceActions({
  refreshDashboardStatus,
  workspacesById,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  setSelectedSessionId,
  setSnapshot,
  detectedIdes,
  setDefaultIde
}: WorkspaceActions) {
  const archive = useCallback(async (workspaceId: string): Promise<void> => {
    const api = window.argmax;
    if (!api) {
      showErrorToast("Open Argmax on your Mac to archive workspaces.");
      return;
    }
    const confirmDirtyArchive = (target: WorkspaceSummary): Promise<boolean> => {
      const fileLabel = target.changedFiles === 1 ? "1 uncommitted change" : `${target.changedFiles} uncommitted changes`;
      return api.system.confirm(
        `${target.taskLabel} has ${fileLabel}. Archive this worktree and keep its files in recovery storage?`
      );
    };
    const workspace = workspacesById.get(workspaceId);
    let force = false;
    let result: Awaited<ReturnType<typeof api.workspaces.archive>>;
    try {
      if (workspace?.dirty && !workspace.sharedWorkspace) {
        if (!(await confirmDirtyArchive(workspace))) return;
        force = true;
      }
      result = await api.workspaces.archive({ workspaceId, force });
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Could not archive the workspace.");
      return;
    }
    // A fresh backend status can find changes absent from the cached snapshot.
    if (result.workspace.state === "kept" && !force && !result.workspace.sharedWorkspace) {
      try {
        if (!(await confirmDirtyArchive(result.workspace))) {
          setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result.workspace] }));
          return;
        }
        result = await api.workspaces.archive({ workspaceId, force: true });
      } catch (error) {
        showErrorToast(error instanceof Error ? error.message : "Could not archive the workspace.");
        return;
      }
    }
    setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result.workspace] }));
    if (result.workspace.state !== "archived") {
      showInfoToast("Workspace has uncommitted changes — kept in sidebar. Commit or discard, then retry archive.");
      return;
    }
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId(null);
      setSelectedSessionId(null);
    }
    prunePaneGrid((cell) => cell.kind === "launcher" || cell.workspaceId !== workspaceId);
  }, [selectedWorkspaceId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot, workspacesById]);

  const openInIde = useCallback(
    async (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }): Promise<void> => {
      const api = window.argmax;
      if (!api) {
        showErrorToast("Open Argmax on your Mac to launch an IDE.");
        return;
      }
      try {
        await api.workspaces.openInIde({ workspaceId, ide });
        if (options?.pinAsDefault) setDefaultIde(ide);
      } catch (error) {
        const ideLabel = detectedIdes.find((entry) => entry.id === ide)?.label ?? ide;
        showErrorToast(error instanceof Error
          ? `Couldn't launch ${ideLabel}. ${error.message}`
          : `Couldn't launch ${ideLabel}.`);
      }
    },
    [detectedIdes, setDefaultIde]
  );

  const runRowCommand = useCallback(
    (blockedMessage: string, failureMessage: string, call: (api: ArgmaxApi) => Promise<unknown>): void => {
      const api = window.argmax;
      if (!api) {
        showErrorToast(blockedMessage);
        return;
      }
      void withToast(() => call(api), showToast, failureMessage).then((ok) =>
        ok ? refreshDashboardStatus() : undefined
      );
    },
    [refreshDashboardStatus]
  );

  // Stable callbacks keep memoized sidebar rows from repainting on each delta.
  const togglePinned = useCallback(
    (workspaceId: string, pinned: boolean): void =>
      runRowCommand("Open Argmax on your Mac to pin a chat.", "Could not toggle pin.", (api) =>
        api.workspaces.setPinned({ workspaceId, pinned })),
    [runRowCommand]
  );
  const rename = useCallback(
    (workspaceId: string, taskLabel: string): void =>
      runRowCommand("Open Argmax on your Mac to rename a chat.", "Could not rename chat.", (api) =>
        api.workspaces.setLabel({ workspaceId, taskLabel })),
    [runRowCommand]
  );
  const removeFromPriority = useCallback(
    (workspaceId: string): void =>
      runRowCommand(
        "Open Argmax on your Mac to change priority.",
        "Could not remove the chat from priority.",
        (api) => api.workspaces.setPriorityDismissed({ workspaceId, dismissed: true })
      ),
    [runRowCommand]
  );
  const addToPriority = useCallback(
    (workspaceId: string): void =>
      runRowCommand(
        "Open Argmax on your Mac to change priority.",
        "Could not add the chat to priority.",
        (api) => api.workspaces.setPriorityAdded({ workspaceId, added: true })
      ),
    [runRowCommand]
  );
  const snooze = useCallback(
    (workspaceId: string, until: string): void =>
      runRowCommand(
        "Open Argmax on your Mac to snooze a chat.",
        "Could not snooze the chat.",
        (api) => api.workspaces.setSnoozedUntil({ workspaceId, until })
      ),
    [runRowCommand]
  );
  const unsnooze = useCallback(
    (workspaceId: string): void =>
      runRowCommand(
        "Open Argmax on your Mac to unsnooze a chat.",
        "Could not unsnooze the chat.",
        (api) => api.workspaces.setSnoozedUntil({ workspaceId, until: null })
      ),
    [runRowCommand]
  );
  const clearPriority = useCallback(
    (workspaceIds: string[]): void =>
      runRowCommand(
        "Open Argmax on your Mac to change priority.",
        "Could not clear priority.",
        (api) => Promise.all(workspaceIds.map((workspaceId) =>
          api.workspaces.setPriorityDismissed({ workspaceId, dismissed: true })
        ))
      ),
    [runRowCommand]
  );
  const setIcon = useCallback(
    (workspaceId: string, icon: string | null, iconColor: string | null): void =>
      runRowCommand(
        "Open Argmax on your Mac to change a chat icon.",
        "Could not change the chat icon.",
        (api) => api.workspaces.setIcon({ workspaceId, icon, iconColor })
      ),
    [runRowCommand]
  );
  const syncNow = useCallback((): void => {
    const api = window.argmax;
    if (!api) {
      showErrorToast("Open Argmax on your Mac to sync chats.");
      return;
    }
    void withToast(() => api.sync.runNow(), showToast, "Could not run chat sync.");
  }, []);

  return {
    archive,
    openInIde,
    togglePinned,
    rename,
    removeFromPriority,
    addToPriority,
    snooze,
    unsnooze,
    clearPriority,
    setIcon,
    syncNow
  };
}
