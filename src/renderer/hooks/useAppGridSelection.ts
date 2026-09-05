import { useCallback, useEffect, useMemo, type MutableRefObject } from "react";
import {
  SCRATCH_PROJECT_ID,
  type DashboardSnapshot,
  type ProjectSummary,
  type SessionSummary,
  type WorkspaceSummary
} from "../../shared/types.js";
import type { WorkspaceClickModifiers } from "../components/SidebarSessionRow.js";
import {
  focusedCell,
  isSessionCell,
  type GridCoord,
  type GridState,
  type SplitPosition
} from "../lib/gridState.js";
import {
  closePane,
  dropWorkspacePane,
  openLauncherPane,
  openWorkspacePane,
  paneGridSnapshot,
  prunePaneGrid,
  usePaneGrid
} from "../state/paneGrid.js";
import {
  useDraggingWorkspaceId,
  useWorkspaceDragCleanup
} from "../state/workspaceDrag.js";

export interface UseAppGridSelectionParams {
  snapshot: DashboardSnapshot;
  selectedProject: ProjectSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  pendingSelectionRef: MutableRefObject<{ sessionId: string; workspaceId: string } | null>;
  maxColumnsPerRow: number;
  setSelectedSessionId: (value: string | null) => void;
  setSelectedWorkspaceId: (value: string | null) => void;
  setSelectedProjectId: (value: string | null) => void;
  showErrorToast: (message: string) => void;
  /**
   * When false, the focused grid cell does not overwrite dashboard selection.
   * Full-view new chat hides the grid without dropping it, and the launcher's
   * project picker must keep the repo the user just chose.
   */
  mirrorFocusedSelection?: boolean;
}

export interface UseAppGridSelectionResult {
  grid: GridState;
  sessionsById: Map<string, SessionSummary>;
  workspacesById: Map<string, WorkspaceSummary>;
  projectsById: Map<string, ProjectSummary>;
  draggingWorkspaceId: string | null;
  openWorkspaceChat: (workspaceId: string, modifiers?: WorkspaceClickModifiers) => void;
  closeFocusedPane: () => boolean;
  handleDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  openLauncherPaneInGrid: () => void;
}

/**
 * Resolves grid moves against the dashboard snapshot: which session a sidebar
 * row opens, which project a new launcher cell targets, and which panes no
 * longer have rows behind them. The grid itself lives in `state/paneGrid`,
 * where panes and the sidebar read it without going through the shell.
 */
export function useAppGridSelection({
  snapshot,
  selectedProject,
  selectedWorkspace,
  pendingSelectionRef,
  maxColumnsPerRow,
  setSelectedSessionId,
  setSelectedWorkspaceId,
  setSelectedProjectId,
  showErrorToast,
  mirrorFocusedSelection = true
}: UseAppGridSelectionParams): UseAppGridSelectionResult {
  const grid = usePaneGrid();
  const draggingWorkspaceId = useDraggingWorkspaceId();
  useWorkspaceDragCleanup();

  const sessionsById = useMemo(
    () => new Map(snapshot.sessions.map((s) => [s.id, s])),
    [snapshot.sessions]
  );
  const workspacesById = useMemo(
    () => new Map(snapshot.workspaces.map((w) => [w.id, w])),
    [snapshot.workspaces]
  );
  const projectsById = useMemo(
    () => new Map(snapshot.projects.map((p) => [p.id, p])),
    [snapshot.projects]
  );

  // Drops grid cells whose session disappeared (archive, restart) so the grid
  // stays in sync with the snapshot without stale panes.
  useEffect(() => {
    prunePaneGrid((cell) => {
      if (!isSessionCell(cell)) return projectsById.has(cell.projectId);
      const pending = pendingSelectionRef.current;
      if (pending?.sessionId === cell.sessionId && pending.workspaceId === cell.workspaceId) {
        return true;
      }
      const workspace = workspacesById.get(cell.workspaceId);
      return sessionsById.has(cell.sessionId) && workspace !== undefined && workspace.state !== "archived";
    });
  }, [pendingSelectionRef, projectsById, sessionsById, workspacesById]);

  // Mirror grid.focused → hook selection state so palette/search/IDE-open
  // paths that still read `selectedSession` stay aligned with the visible
  // pane. A dashboard:delta rebuilds `workspacesById`, so this must not run
  // while the full launcher is composing: the hidden focused session would
  // steal the project chip back from an explicit picker choice.
  useEffect(() => {
    if (!mirrorFocusedSelection) return;
    const cell = focusedCell(grid);
    if (cell && isSessionCell(cell)) {
      setSelectedSessionId(cell.sessionId);
      setSelectedWorkspaceId(cell.workspaceId);
      const workspace = workspacesById.get(cell.workspaceId);
      if (workspace) setSelectedProjectId(workspace.projectId);
      return;
    }
    if (cell?.kind === "launcher") {
      setSelectedSessionId(null);
      setSelectedWorkspaceId(null);
      setSelectedProjectId(cell.projectId);
      return;
    }
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [
    grid,
    mirrorFocusedSelection,
    setSelectedProjectId,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    workspacesById
  ]);

  const openWorkspaceChat = useCallback(
    (workspaceId: string, modifiers: WorkspaceClickModifiers = { ctrlOrMeta: false, alt: false }): void => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace || workspace.state === "archived") return;
      const sessionForWorkspace = snapshot.sessions.find((s) => s.workspaceId === workspaceId);
      if (!sessionForWorkspace) {
        showErrorToast("This chat isn't loaded — try refreshing the dashboard.");
        return;
      }
      setSelectedProjectId(workspace.projectId);
      openWorkspacePane(
        { sessionId: sessionForWorkspace.id, workspaceId },
        modifiers,
        { maxColumns: maxColumnsPerRow }
      );
    },
    [maxColumnsPerRow, snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
  );

  const closeFocusedPane = useCallback((): boolean => {
    const focused = grid.focused;
    if (!focused) return false;
    closePane(focused);
    return true;
  }, [grid.focused]);

  const handleDropWorkspace = useCallback(
    (workspaceId: string, target: GridCoord & { position: SplitPosition }): void => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace || workspace.state === "archived") return;
      const sessionForWorkspace = snapshot.sessions.find((s) => s.workspaceId === workspaceId);
      if (!sessionForWorkspace) {
        showErrorToast("This chat isn't loaded — try refreshing the dashboard.");
        return;
      }
      setSelectedProjectId(workspace.projectId);
      dropWorkspacePane(
        { sessionId: sessionForWorkspace.id, workspaceId },
        target,
        { maxColumns: maxColumnsPerRow }
      );
    },
    [maxColumnsPerRow, snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
  );

  const openLauncherPaneInGrid = useCallback((): void => {
    // Never seed a launcher cell with the hidden scratch project — it owns
    // repo-less side chats, and a launcher targeting it would offer branch
    // and worktree chrome against the app-owned scratch root.
    const repoProjectId = (id: string | null | undefined): string | null =>
      id && id !== SCRATCH_PROJECT_ID ? id : null;
    const focused = focusedCell(paneGridSnapshot());
    let projectId =
      repoProjectId(selectedProject?.id) ??
      repoProjectId(selectedWorkspace?.projectId) ??
      snapshot.projects.find((project) => project.id !== SCRATCH_PROJECT_ID)?.id ??
      null;
    if (focused && isSessionCell(focused)) {
      projectId = repoProjectId(workspacesById.get(focused.workspaceId)?.projectId) ?? projectId;
    } else if (focused?.kind === "launcher") {
      projectId = focused.projectId;
    }
    if (!projectId) return;
    if (openLauncherPane({ kind: "launcher", projectId }, { maxColumns: maxColumnsPerRow }) === "grid-full") {
      showErrorToast("The grid is full. Close a pane to start a new chat here.");
    }
  }, [
    maxColumnsPerRow,
    selectedProject?.id,
    selectedWorkspace?.projectId,
    showErrorToast,
    snapshot.projects,
    workspacesById
  ]);

  return {
    grid,
    sessionsById,
    workspacesById,
    projectsById,
    draggingWorkspaceId,
    openWorkspaceChat,
    closeFocusedPane,
    handleDropWorkspace,
    openLauncherPaneInGrid
  };
}
