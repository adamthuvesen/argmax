import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type {
  DashboardSnapshot,
  ProjectSummary,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { WorkspaceClickModifiers } from "../components/SidebarSessionRow.js";
import { buildAgentActivity } from "../lib/agentActivity.js";
import {
  EMPTY_GRID,
  closeAgentTab as closeAgentTabInGrid,
  closeCell,
  dropWorkspaceInGrid,
  findAgentCellForParent,
  findSessionCell,
  focusedCell,
  isAgentCell,
  isSessionCell,
  isWorkspaceBackedCell,
  openAgentInGrid,
  openLauncherInGrid,
  openWorkspaceInGrid,
  setActiveAgentTab,
  setFocus,
  type AgentPaneRequest,
  type GridCell,
  type GridCoord,
  type GridState,
  type SplitPosition
} from "../lib/gridState.js";

/** When some subagent tabs are pruned, keep the active tab if it survived,
    else fall to the nearest surviving neighbour (right first, then left). */
function nearestSurvivingId(originalIds: string[], liveIds: string[], activeId: string): string {
  const live = new Set(liveIds);
  const activeIndex = originalIds.indexOf(activeId);
  if (activeIndex === -1) return liveIds[0] ?? activeId;
  for (let offset = 1; offset < originalIds.length; offset++) {
    const right = originalIds[activeIndex + offset];
    if (right && live.has(right)) return right;
    const left = originalIds[activeIndex - offset];
    if (left && live.has(left)) return left;
  }
  return liveIds[0] ?? activeId;
}

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
  openAgentPane: (request: AgentPaneRequest) => void;
  activateAgentTab: (parentSessionId: string, parentToolUseId: string) => void;
  closeAgentTab: (parentSessionId: string, parentToolUseId: string) => void;
  handleDropWorkspace: (workspaceId: string, target: GridCoord & { position: SplitPosition }) => void;
  handleWorkspaceDragStart: (workspaceId: string) => void;
  handleWorkspaceDragEnd: () => void;
  openLauncherPaneInGrid: () => void;
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
    () => new Set(grid.rows.flatMap((row) => row.filter(isWorkspaceBackedCell).map((cell) => cell.workspaceId))),
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
            if (isAgentCell(cell)) {
              const parentSession = sessionsById.get(cell.parentSessionId);
              const parentSessionIsVisible = current.rows.some((candidateRow) =>
                candidateRow.some(
                  (candidateCell) =>
                    isSessionCell(candidateCell) &&
                    candidateCell.sessionId === cell.parentSessionId
                )
              );
              if (!parentSessionIsVisible || !parentSession || !workspacesById.has(cell.workspaceId)) {
                mutated = true;
                continue;
              }
              const sessionEvents = eventsBySessionId.get(cell.parentSessionId) ?? [];
              const sessionRunning = parentSession.state === "running";
              // Prune subagent tabs whose launch tool is no longer in the
              // timeline (superseded retry, dropped completion); keep the cell
              // as long as one tab survives.
              const liveIds = cell.parentToolUseIds.filter(
                (id) =>
                  buildAgentActivity({
                    parentToolUseId: id,
                    events: sessionEvents,
                    sessionRunning
                  }).parentTool !== null
              );
              if (liveIds.length === 0) {
                mutated = true;
                continue;
              }
              if (liveIds.length === cell.parentToolUseIds.length) {
                // Referential stability: nothing changed, reuse the same object
                // so the effect doesn't churn the grid on every snapshot.
                next.push(cell);
                continue;
              }
              mutated = true;
              next.push({
                ...cell,
                parentToolUseIds: liveIds,
                activeParentToolUseId: liveIds.includes(cell.activeParentToolUseId)
                  ? cell.activeParentToolUseId
                  : nearestSurvivingId(cell.parentToolUseIds, liveIds, cell.activeParentToolUseId)
              });
              continue;
            }
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
            if (sessionsById.has(cell.sessionId) && workspacesById.has(cell.workspaceId)) {
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
    if (cell && isAgentCell(cell)) {
      setSelectedSessionId(cell.parentSessionId);
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

  const openAgentPane = useCallback(
    (request: AgentPaneRequest): void => {
      // A parent that already has an agent cell absorbs the request as a tab,
      // so it can never hit the pane limit — only the first subagent can.
      const hasParentCell = findAgentCellForParent(grid, request.parentSessionId) !== null;
      const nextForCurrent = openAgentInGrid(grid, request, { maxColumns: maxColumnsPerRow });
      const blocked = nextForCurrent === grid && !hasParentCell;
      setGrid((current) => openAgentInGrid(current, request, { maxColumns: maxColumnsPerRow }));
      if (!blocked) return;
      // openAgentInGrid also no-ops when the parent session pane is missing
      // or nothing is focused — only a full grid is a pane-limit failure.
      if (!findSessionCell(grid, request.parentSessionId)) {
        showErrorToast("Open the agent's parent session in the grid first.");
      } else if (grid.focused !== null) {
        showErrorToast("Pane limit reached — close a pane before opening this agent.");
      }
    },
    [grid, maxColumnsPerRow, showErrorToast]
  );

  const activateAgentTab = useCallback(
    (parentSessionId: string, parentToolUseId: string): void => {
      setGrid((current) => setActiveAgentTab(current, parentSessionId, parentToolUseId));
    },
    []
  );

  const closeAgentTab = useCallback(
    (parentSessionId: string, parentToolUseId: string): void => {
      setGrid((current) => closeAgentTabInGrid(current, parentSessionId, parentToolUseId));
    },
    []
  );

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
      let projectId = selectedProject?.id ?? selectedWorkspace?.projectId ?? snapshot.projects[0]?.id ?? null;
      if (focused && isWorkspaceBackedCell(focused)) {
        projectId = workspacesById.get(focused.workspaceId)?.projectId ?? projectId;
      } else if (focused?.kind === "launcher") {
        projectId = focused.projectId;
      }
      if (!projectId) return current;
      return openLauncherInGrid(current, { kind: "launcher", projectId }, { maxColumns: maxColumnsPerRow });
    });
  }, [
    maxColumnsPerRow,
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
    openAgentPane,
    activateAgentTab,
    closeAgentTab,
    handleDropWorkspace,
    handleWorkspaceDragStart,
    handleWorkspaceDragEnd,
    openLauncherPaneInGrid
  };
}
