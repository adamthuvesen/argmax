import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import {
  SCRATCH_PROJECT_ID,
  type DashboardSnapshot,
  type ProjectSummary,
  type SessionSummary,
  type TimelineEvent,
  type WorkspaceSummary
} from "../../shared/types.js";
import type { WorkspaceClickModifiers } from "../components/SidebarSessionRow.js";
import {
  EMPTY_GRID,
  closeCell,
  dropWorkspaceInGrid,
  findLauncherCell,
  focusedCell,
  isSessionCell,
  openLauncherInGrid,
  openWorkspaceInGrid,
  setFocus,
  setLauncherProject,
  type GridCell,
  type GridCoord,
  type GridState,
  type SplitPosition
} from "../lib/gridState.js";

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
  setLauncherPaneProject: (projectId: string) => void;
}

export function useAppGridSelection({
  snapshot,
  selectedProject,
  selectedWorkspace,
  pendingSelectionRef,
  maxColumnsPerRow,
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
  const eventsBySessionId = useMemo(() => {
    const bySession = new Map<string, TimelineEvent[]>();
    for (const event of snapshot.events) {
      const current = bySession.get(event.sessionId);
      if (current) {
        current.push(event);
      } else {
        bySession.set(event.sessionId, [event]);
      }
    }
    return bySession;
  }, [snapshot.events]);

  const openWorkspaceIds = useMemo(
    () => new Set(grid.rows.flatMap((row) => row.filter(isSessionCell).map((cell) => cell.workspaceId))),
    [grid.rows]
  );
  const canDragWorkspaceToGrid = snapshot.sessions.length > 0;

  // Mirror the focused grid cell into the dashboard hook's single-selection
  // state so palette/search/IDE-open code paths (which still look at
  // `selectedSession`) keep working. Also drops grid cells whose session
  // disappeared (archive, restart) so the grid stays in sync with the
  // snapshot without stale panes.
  useEffect(() => {
    setGrid((current) => {
      if (current.rows.length === 0) return current;
      let mutated = false;
      const pending = pendingSelectionRef.current;
      const rows = current.rows
        .map((row) => {
          const next: GridCell[] = [];
          for (const cell of row) {
            if (!isSessionCell(cell)) {
              if (projectsById.has(cell.projectId)) next.push(cell);
              else mutated = true;
              continue;
            }
            if (
              pending?.sessionId === cell.sessionId &&
              pending.workspaceId === cell.workspaceId
            ) {
              next.push(cell);
              continue;
            }
            const workspace = workspacesById.get(cell.workspaceId);
            if (sessionsById.has(cell.sessionId) && workspace && workspace.state !== "archived") {
              next.push(cell);
            } else {
              mutated = true;
            }
          }
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
  }, [eventsBySessionId, pendingSelectionRef, projectsById, sessionsById, workspacesById]);

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
      if (!workspace || workspace.state === "archived") return;
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
          modifiers,
          { maxColumns: maxColumnsPerRow }
        )
      );
    },
    [maxColumnsPerRow, snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
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
      if (!workspace || workspace.state === "archived") return;
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
          target,
          { maxColumns: maxColumnsPerRow }
        )
      );
    },
    [maxColumnsPerRow, snapshot.sessions, workspacesById, setSelectedProjectId, showErrorToast]
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
      // Never seed a launcher cell with the hidden scratch project — it owns
      // repo-less side chats, and a launcher targeting it would offer branch
      // and worktree chrome against the app-owned scratch root.
      const repoProjectId = (id: string | null | undefined): string | null =>
        id && id !== SCRATCH_PROJECT_ID ? id : null;
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
      if (!projectId) return current;
      const next = openLauncherInGrid(
        current,
        { kind: "launcher", projectId },
        { maxColumns: maxColumnsPerRow }
      );
      // A full grid silently swallows the request otherwise, which reads as a
      // dead button rather than as a limit the user can act on.
      if (next === current && findLauncherCell(current) === null) {
        showErrorToast("The grid is full. Close a pane to start a new session here.");
      }
      return next;
    });
  }, [
    maxColumnsPerRow,
    selectedProject?.id,
    selectedWorkspace?.projectId,
    showErrorToast,
    snapshot.projects,
    workspacesById
  ]);

  const setLauncherPaneProject = useCallback((projectId: string): void => {
    setGrid((current) => setLauncherProject(current, projectId));
  }, []);

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
    openLauncherPaneInGrid,
    setLauncherPaneProject
  };
}
