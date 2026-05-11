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
  saveCollapsedProjectIds,
  saveProjectOrder
} from "../lib/projects.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";

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
  isSettingsActive: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  snapshot: DashboardSnapshot;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
}): JSX.Element {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => loadCollapsedProjectIds());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const toggleProjectVisibility = useCallback((projectId: string): void => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      saveCollapsedProjectIds(next);
      return next;
    });
  }, []);

  const expandProjectVisibility = useCallback((projectId: string): void => {
    setCollapsedProjectIds((current) => {
      if (!current.has(projectId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectId);
      saveCollapsedProjectIds(next);
      return next;
    });
  }, []);

  const handleDragStart = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    setDraggingId(projectId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(projectId);
  }, []);

  const handleDrop = useCallback((e: ReactDragEvent<HTMLDivElement>, targetId: string, currentOrdered: ProjectSummary[]): void => {
    e.preventDefault();
    setDraggingId((currentDraggingId) => {
      if (currentDraggingId && currentDraggingId !== targetId) {
        const ids = currentOrdered.map((p) => p.id);
        const from = ids.indexOf(currentDraggingId);
        const to = ids.indexOf(targetId);
        if (from !== -1 && to !== -1) {
          const next = [...ids];
          next.splice(from, 1);
          next.splice(to, 0, currentDraggingId);
          saveProjectOrder(next);
          setProjectOrder(next);
        }
      }
      return null;
    });
    setDragOverId(null);
  }, []);

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
          const projectWorkspaces = snapshot.workspaces
            .filter((workspace) => workspace.projectId === project.id && workspace.state !== "archived")
            .slice(0, 7);
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
                    <SidebarSessionRow
                      key={workspace.id}
                      workspace={workspace}
                      workspaceCost={workspaceCostMap.get(workspace.id) ?? 0}
                      isSelected={selectedWorkspaceId === workspace.id}
                      onOpenWorkspaceChat={onOpenWorkspaceChat}
                      onArchiveWorkspace={onArchiveWorkspace}
                      onOpenInIde={onOpenInIde}
                      detectedIdes={detectedIdes}
                      defaultIde={defaultIde}
                    />
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
