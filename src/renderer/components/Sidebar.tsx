import { ChevronRight, Folder, Plus, Settings } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { DashboardSnapshot, DetectedIde, IdeId, ProjectSummary } from "../../shared/types.js";
import {
  applyProjectOrder,
  loadCollapsedProjectIds,
  loadProjectOrder,
  loadWorkspaceOrders,
  saveCollapsedProjectIds,
  saveProjectOrder,
  saveWorkspaceOrders,
  sortWorkspaceGroup
} from "../lib/projects.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";
import { useNow } from "../hooks/useNow.js";

export function Sidebar({
  loadState,
  onAddProject,
  onArchiveWorkspace,
  onOpenInIde,
  onOpenLauncher,
  onOpenProject,
  onOpenSettings,
  onOpenWorkspaceChat,
  onResizeMouseDown,
  onToggleWorkspacePinned,
  isSettingsActive,
  selectedProjectId,
  selectedWorkspaceId,
  snapshot,
  detectedIdes,
  defaultIde
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onOpenLauncher: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onOpenWorkspaceChat: (workspaceId: string) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  onToggleWorkspacePinned?: (workspaceId: string, pinned: boolean) => void;
  isSettingsActive: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  snapshot: DashboardSnapshot;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
}): JSX.Element {
  // Single shared 5s tick drives the per-row "last activity ago" badge.
  // Lifting the interval here is intentional — N row instances each with
  // their own setInterval would cause N independent re-renders per tick.
  const now = useNow(true, 5000);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => loadCollapsedProjectIds());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [workspaceOrders, setWorkspaceOrders] = useState<Record<string, string[]>>(() => loadWorkspaceOrders());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);

  const orderedProjects = useMemo(
    () => applyProjectOrder(snapshot.projects, projectOrder),
    [snapshot.projects, projectOrder]
  );

  const workspaceCostMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of snapshot.sessions) {
      const prev = map.get(session.workspaceId) ?? 0;
      map.set(session.workspaceId, prev + (session.costUsd ?? 0));
    }
    return map;
  }, [snapshot.sessions]);

  // Compute next outside the setState updater so the localStorage write fires
  // exactly once per toggle. (React 18 StrictMode runs updater callbacks
  // twice in dev — a side effect inside one would persist twice.)
  const toggleProjectVisibility = useCallback(
    (projectId: string): void => {
      const next = new Set(collapsedProjectIds);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      setCollapsedProjectIds(next);
      saveCollapsedProjectIds(next);
    },
    [collapsedProjectIds]
  );

  const expandProjectVisibility = useCallback(
    (projectId: string): void => {
      if (!collapsedProjectIds.has(projectId)) {
        return;
      }
      const next = new Set(collapsedProjectIds);
      next.delete(projectId);
      setCollapsedProjectIds(next);
      saveCollapsedProjectIds(next);
    },
    [collapsedProjectIds]
  );

  const handleDragStart = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    setDraggingId(projectId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(projectId);
  }, []);

  const handleDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>, targetId: string, currentOrdered: ProjectSummary[]): void => {
      e.preventDefault();
      if (draggingId && draggingId !== targetId) {
        const ids = currentOrdered.map((p) => p.id);
        const from = ids.indexOf(draggingId);
        const to = ids.indexOf(targetId);
        if (from !== -1 && to !== -1) {
          const next = [...ids];
          next.splice(from, 1);
          next.splice(to, 0, draggingId);
          setProjectOrder(next);
          saveProjectOrder(next);
        }
      }
      setDraggingId(null);
      setDragOverId(null);
    },
    [draggingId]
  );

  const handleDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    // Only clear when the cursor leaves the row itself, not when it enters a
    // child element (which also fires dragleave on the parent).
    const related = e.relatedTarget;
    if (related instanceof Node && e.currentTarget.contains(related)) return;
    setDragOverId((current) => (current === projectId ? null : current));
  }, []);

  const handleDragEnd = useCallback((): void => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  const handleWorkspaceDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>, workspaceId: string): void => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    setDraggingWorkspaceId(workspaceId);
  }, []);

  const handleWorkspaceDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (draggingWorkspaceId) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }, [draggingWorkspaceId]);

  const handleWorkspaceDrop = useCallback(
    (
      event: ReactDragEvent<HTMLDivElement>,
      projectId: string,
      targetWorkspaceId: string,
      orderedIds: string[]
    ): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!draggingWorkspaceId || draggingWorkspaceId === targetWorkspaceId) {
        setDraggingWorkspaceId(null);
        return;
      }
      const from = orderedIds.indexOf(draggingWorkspaceId);
      const to = orderedIds.indexOf(targetWorkspaceId);
      if (from === -1 || to === -1) {
        setDraggingWorkspaceId(null);
        return;
      }
      const next = [...orderedIds];
      next.splice(from, 1);
      next.splice(to, 0, draggingWorkspaceId);
      const updated = { ...workspaceOrders, [projectId]: next };
      setWorkspaceOrders(updated);
      saveWorkspaceOrders(updated);
      setDraggingWorkspaceId(null);
    },
    [draggingWorkspaceId, workspaceOrders]
  );

  const handleWorkspaceDragEnd = useCallback((): void => {
    setDraggingWorkspaceId(null);
  }, []);

  return (
    <aside className="sidebar" data-loading={loadState === "loading" ? "true" : undefined}>
      <div className="window-controls" />
      <nav className="rail-nav" aria-label="Primary">
        <button
          className="rail-nav-item"
          type="button"
          title="New session"
          aria-label="New session"
          onClick={onOpenLauncher}
        >
          <Plus size={16} />
          <span>New session</span>
        </button>
      </nav>

      <div className="project-list">
        <div className="rail-heading">
          <p className="rail-label">Projects</p>
          <button className="small-icon" type="button" title="Add Project" aria-label="Add Project" onClick={onAddProject}>
            <Plus size={16} />
          </button>
        </div>
        {orderedProjects.map((project) => {
          const manualOrder = workspaceOrders[project.id] ?? [];
          const projectWorkspaces = sortWorkspaceGroup(
            snapshot.workspaces.filter(
              (workspace) => workspace.projectId === project.id && workspace.state !== "archived"
            ),
            manualOrder
          ).slice(0, 7);
          const orderedWorkspaceIds = projectWorkspaces.map((workspace) => workspace.id);
          const isCollapsed = collapsedProjectIds.has(project.id);
          const isDragging = draggingId === project.id;
          const isDragOver = dragOverId === project.id && !isDragging;
          return (
            <div
              className={`project-group${isDragging ? " dragging" : ""}${isDragOver ? " drag-over" : ""}`}
              data-collapsed={isCollapsed ? "true" : undefined}
              draggable
              key={project.id}
              onDragStart={(e) => handleDragStart(e, project.id)}
              onDragOver={(e) => handleDragOver(e, project.id)}
              onDragLeave={(e) => handleDragLeave(e, project.id)}
              onDrop={(e) => handleDrop(e, project.id, orderedProjects)}
              onDragEnd={handleDragEnd}
            >
              <div className="project-row">
                <button
                  aria-pressed={selectedProjectId === project.id && !selectedWorkspaceId}
                  className={
                    selectedProjectId === project.id && !selectedWorkspaceId ? "project-name active" : "project-name"
                  }
                  type="button"
                  onClick={() => {
                    expandProjectVisibility(project.id);
                    onOpenProject(project.id);
                    onOpenLauncher();
                  }}
                >
                  <Folder size={16} />
                  <span>{project.name}</span>
                </button>
                <button
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Show" : "Hide"} ${project.name} sessions`}
                  className="project-visibility"
                  title={`${isCollapsed ? "Show" : "Hide"} Sessions`}
                  type="button"
                  onClick={() => toggleProjectVisibility(project.id)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {isCollapsed
                ? null
                : projectWorkspaces.map((workspace) => (
                    <div
                      key={workspace.id}
                      className={`session-row-wrap${draggingWorkspaceId === workspace.id ? " dragging" : ""}`}
                      draggable={Boolean(onToggleWorkspacePinned)}
                      onDragStart={(event) => handleWorkspaceDragStart(event, workspace.id)}
                      onDragOver={handleWorkspaceDragOver}
                      onDrop={(event) =>
                        handleWorkspaceDrop(event, project.id, workspace.id, orderedWorkspaceIds)
                      }
                      onDragEnd={handleWorkspaceDragEnd}
                    >
                      <SidebarSessionRow
                        workspace={workspace}
                        workspaceCost={workspaceCostMap.get(workspace.id) ?? 0}
                        isSelected={selectedWorkspaceId === workspace.id}
                        now={now}
                        onOpenWorkspaceChat={onOpenWorkspaceChat}
                        onArchiveWorkspace={onArchiveWorkspace}
                        onOpenInIde={onOpenInIde}
                        onTogglePin={onToggleWorkspacePinned}
                        detectedIdes={detectedIdes}
                        defaultIde={defaultIde}
                      />
                    </div>
                  ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="identity-chip" data-state={loadState}>
          <span className="identity-avatar" aria-hidden="true">M</span>
          <span className="identity-meta">
            <span className="identity-name">Argmax</span>
            <span className="identity-sub">
              {loadState === "ready" ? "Local · Online" : loadState === "loading" ? "Local · Loading" : "Local · Issue"}
            </span>
          </span>
        </div>
        <button
          className="small-icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-pressed={isSettingsActive}
          onClick={onOpenSettings}
        >
          <Settings size={16} />
        </button>
      </div>
      <div className="sidebar-resizer" aria-hidden="true" onMouseDown={onResizeMouseDown} />
    </aside>
  );
}
