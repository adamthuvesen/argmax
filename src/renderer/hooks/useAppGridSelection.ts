import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { DashboardSnapshot, ProjectSummary, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import type { WorkspaceClickModifiers } from "../components/SidebarSessionRow.js";
import {
  EMPTY_GRID,
  closeCell,
  dropWorkspaceInGrid,
  focusedCell,
  isSessionCell,
  openLauncherInGrid,
  openWorkspaceInGrid,
  setFocus,
  type GridCoord,
  type GridState,
  type SplitPosition
} from "../lib/gridState.js";

export interface UseAppGridSelectionParams {
  snapshot: DashboardSnapshot;
  selectedProject: ProjectSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  setSelectedSessionId: (value: string | null) => void;
  setSelectedWorkspaceId: (value: string | null) => void;
  setSelectedProjectId: (value: string | null) => void;
  showErrorToast: (message: string) => void;
}

export interface UseAppGridSelectionResult {
  grid: GridState;
  setGrid: Dispatch<SetStateAction<GridState>>;
  sessionsById: Map<string, SessionSummary>;
  workspacesById: Map<string, WorkspaceSummary>;
  projectsById: Map<string, ProjectSummary>;
  draggingWorkspaceId: string | null;
  openWorkspaceIds: Set<string>;
  canDragWorkspaceToGrid: boolean;
  openWorkspaceChat: (workspaceId: string, modifiers?: WorkspaceClickModifiers) => void;
  closePane: (coord: GridCoord) => void;
  focusPane: (coord: GridCoord) => void;
  closeFocusedPane: () => boolean;
  handleDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  handleWorkspaceDragStart: (workspaceId: string) => void;
  handleWorkspaceDragEnd: () => void;
  openLauncherPaneInGrid: () => void;
}

export function useAppGridSelection({
  snapshot,
  selectedProject,
  selectedWorkspace,
  setSelectedSessionId,
  setSelectedWorkspaceId,
  setSelectedProjectId,
  showErrorToast
}: UseAppGridSelectionParams): UseAppGridSelectionResult {
  const [grid, setGrid] = useState<GridState>(EMPTY_GRID);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);

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

  const openWorkspaceIds = useMemo(
    () => new Set(grid.rows.flatMap((row) => row.filter(isSessionCell).map((cell) => cell.workspaceId))),
    [grid.rows]
  );
  const canDragWorkspaceToGrid = openWorkspaceIds.size > 0;

  // Mirror the focused grid cell into the dashboard hook's single-selection
  // state so palette/search/IDE-open code paths (which still look at
  // `selectedSession`) keep working. Also drops grid cells whose session
  // disappeared (archive, restart) so the grid stays in sync with the
  // snapshot without stale panes.
  useEffect(() => {
    setGrid((current) => {
      if (current.rows.length === 0) return current;
      let mutated = false;
      const rows = current.rows
        .map((row) => {
          const next = row.filter((cell) => {
            if (!isSessionCell(cell)) return projectsById.has(cell.projectId);
            return sessionsById.has(cell.sessionId) && workspacesById.has(cell.workspaceId);
          });
          if (next.length !== row.length) mutated = true;
          return next;
        })
        .filter((row) => row.length > 0);
      if (!mutated) return current;
      if (rows.length === 0) return EMPTY_GRID;
      const focused = current.focused;
      if (focused) {
        const nextRow = Math.min(focused.row, rows.length - 1);
        const targetRow = rows[nextRow];
        if (targetRow) {
          const nextCol = Math.min(focused.col, targetRow.length - 1);
          return { rows, focused: { row: nextRow, col: Math.max(nextCol, 0) } };
        }
      }
      return { rows, focused: { row: 0, col: 0 } };
    });
  }, [projectsById, sessionsById, workspacesById]);

  // Mirror grid.focused → hook selection state. Avoids racing on initial
  // mount by skipping when the focused cell already matches what the hook
  // last produced.
  useEffect(() => {
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
  }, [grid, setSelectedProjectId, setSelectedSessionId, setSelectedWorkspaceId, workspacesById]);

  const openWorkspaceChat = useCallback(
    (workspaceId: string, modifiers: WorkspaceClickModifiers = { ctrlOrMeta: false, alt: false }): void => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace) return;
      const sessionForWorkspace = snapshot.sessions.find((s) => s.workspaceId === workspaceId);
      if (!sessionForWorkspace) {
        showErrorToast("This session isn't loaded — try refreshing the dashboard.");
        return;
      }
      setSelectedProjectId(workspace.projectId);
      setGrid((current) =>
        openWorkspaceInGrid(
          current,
          { sessionId: sessionForWorkspace.id, workspaceId },
          modifiers
        )
      );
    },
    [snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
  );

  const closePane = useCallback((coord: GridCoord): void => {
    setGrid((current) => closeCell(current, coord.row, coord.col));
  }, []);

  const focusPane = useCallback((coord: GridCoord): void => {
    setGrid((current) => setFocus(current, coord));
  }, []);

  const closeFocusedPane = useCallback((): boolean => {
    const focused = grid.focused;
    if (!focused) return false;
    closePane(focused);
    return true;
  }, [grid.focused, closePane]);

  const handleDropWorkspace = useCallback(
    (workspaceId: string, target: GridCoord & { position: SplitPosition }): void => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace) return;
      const sessionForWorkspace = snapshot.sessions.find((s) => s.workspaceId === workspaceId);
      if (!sessionForWorkspace) {
        showErrorToast("This session isn't loaded — try refreshing the dashboard.");
        return;
      }
      setSelectedProjectId(workspace.projectId);
      setGrid((current) =>
        dropWorkspaceInGrid(
          current,
          { sessionId: sessionForWorkspace.id, workspaceId },
          target
        )
      );
    },
    [snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
  );

  const handleWorkspaceDragStart = useCallback((workspaceId: string): void => {
    setDraggingWorkspaceId(workspaceId);
  }, []);

  const handleWorkspaceDragEnd = useCallback((): void => {
    setDraggingWorkspaceId(null);
  }, []);

  useEffect(() => {
    if (!draggingWorkspaceId) return;
    const clear = (): void => setDraggingWorkspaceId(null);
    document.addEventListener("dragend", clear, true);
    document.addEventListener("drop", clear);
    return () => {
      document.removeEventListener("dragend", clear, true);
      document.removeEventListener("drop", clear);
    };
  }, [draggingWorkspaceId]);

  const openLauncherPaneInGrid = useCallback((): void => {
    setGrid((current) => {
      if (current.rows.length === 0) return EMPTY_GRID;
      const focused = focusedCell(current);
      let projectId = selectedProject?.id ?? selectedWorkspace?.projectId ?? snapshot.projects[0]?.id ?? null;
      if (focused && isSessionCell(focused)) {
        projectId = workspacesById.get(focused.workspaceId)?.projectId ?? projectId;
      } else if (focused?.kind === "launcher") {
        projectId = focused.projectId;
      }
      if (!projectId) return current;
      return openLauncherInGrid(current, { kind: "launcher", projectId });
    });
  }, [
    selectedProject?.id,
    selectedWorkspace?.projectId,
    snapshot.projects,
    workspacesById
  ]);

  return {
    grid,
    setGrid,
    sessionsById,
    workspacesById,
    projectsById,
    draggingWorkspaceId,
    openWorkspaceIds,
    canDragWorkspaceToGrid,
    openWorkspaceChat,
    closePane,
    focusPane,
    closeFocusedPane,
    handleDropWorkspace,
    handleWorkspaceDragStart,
    handleWorkspaceDragEnd,
    openLauncherPaneInGrid
  };
}
