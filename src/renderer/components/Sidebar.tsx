import { Check, ChevronRight, MoreHorizontal, Plus, Settings, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { DashboardSnapshot, DetectedIde, IdeId, ProjectSummary } from "../../shared/types.js";
import { APP_VERSION_LABEL } from "../../shared/appVersion.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import {
  groupWorkspacesByDate,
  loadCollapsedDateGroupIds,
  loadCollapsedProjectIds,
  loadExpandedDateGroupIds,
  loadExpandedProjectIds,
  loadProjectOrder,
  loadProjectSortMode,
  loadSidebarViewMode,
  loadWorkspaceOrders,
  saveCollapsedDateGroupIds,
  saveCollapsedProjectIds,
  saveExpandedDateGroupIds,
  saveExpandedProjectIds,
  saveProjectOrder,
  saveProjectSortMode,
  saveSidebarViewMode,
  saveWorkspaceOrders,
  SIDEBAR_SESSION_LIMIT,
  sortProjectsBy,
  sortWorkspaceGroup,
  type ProjectSortMode,
  type SidebarViewMode
} from "../lib/projects.js";
import { Mascot } from "./Mascot.js";
import { SidebarSessionRow, type WorkspaceClickModifiers } from "./SidebarSessionRow.js";

// Marker stored in sessionStorage (cleared on app quit / window close in
// Tauri) so the "collapse every project on launch" seed fires exactly
// once per real app launch — not on every Sidebar mount. Tests that want
// the old "respect persisted localStorage" behavior pre-set this marker
// in their beforeEach.
const BOOT_COLLAPSE_SEED_KEY = "argmax.sidebar.bootCollapseSeeded";

function readBootCollapseSeeded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.sessionStorage.getItem(BOOT_COLLAPSE_SEED_KEY) === "1";
  } catch {
    return true;
  }
}

function markBootCollapseSeeded(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(BOOT_COLLAPSE_SEED_KEY, "1");
  } catch {
    // SecurityError / QuotaExceeded — fall through; worst case we collapse
    // again on the next render, which is harmless.
  }
}

const VIEW_MODE_OPTIONS: ReadonlyArray<{ value: SidebarViewMode; label: string; description: string }> = [
  { value: "projects", label: "Projects", description: "Group sessions under their project" },
  { value: "sessions", label: "Date", description: "Flat list of all sessions by date" }
];

const SORT_MODE_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string; description: string }> = [
  { value: "recent", label: "Recent activity", description: "Most recently active project first" },
  { value: "alphabetical", label: "Alphabetical (A→Z)", description: "Sort by project name" },
  { value: "manual", label: "Manual", description: "Drag to reorder" }
];

function formatNameplateDate(): string {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}·${day}`;
}

export function Sidebar({
  loadState,
  onAddProject,
  onArchiveWorkspace,
  onOpenInIde,
  onOpenLauncher,
  onOpenProject,
  onOpenSettings,
  onOpenWorkspaceChat,
  onRemoveProject,
  onRenameWorkspace,
  onResizeMouseDown,
  onToggleWorkspacePinned,
  onWorkspaceDragStart,
  onWorkspaceDragEnd,
  isSettingsActive,
  selectedProjectId,
  selectedWorkspaceId,
  openWorkspaceIds,
  canDragWorkspaceToGrid,
  snapshot,
  detectedIdes,
  defaultIde,
  showSessionTokens
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onOpenLauncher: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onOpenWorkspaceChat: (workspaceId: string, modifiers: WorkspaceClickModifiers) => void;
  onRemoveProject?: (projectId: string) => void;
  onRenameWorkspace?: (workspaceId: string, taskLabel: string) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  onToggleWorkspacePinned?: (workspaceId: string, pinned: boolean) => void;
  /** Notifies the parent that a sidebar drag started carrying this workspace. */
  onWorkspaceDragStart?: (workspaceId: string) => void;
  /** Notifies the parent that a sidebar drag finished (drop or cancel). */
  onWorkspaceDragEnd?: () => void;
  isSettingsActive: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  openWorkspaceIds: Set<string>;
  canDragWorkspaceToGrid: boolean;
  snapshot: DashboardSnapshot;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  showSessionTokens: boolean;
}): JSX.Element {
  // Per-launch behavior: every project starts collapsed so no sessions are
  // visible on app start. After the first non-empty snapshot, we set a
  // sessionStorage marker so subsequent re-mounts within the same renderer
  // process (e.g. hot-reload) respect the persisted state and don't
  // re-collapse projects the user has since expanded.
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() =>
    readBootCollapseSeeded() ? loadCollapsedProjectIds() : new Set()
  );
  const startupCollapseInitializedRef = useRef(readBootCollapseSeeded());
  if (!startupCollapseInitializedRef.current && snapshot.projects.length > 0) {
    startupCollapseInitializedRef.current = true;
    const allCollapsed = new Set(snapshot.projects.map((project) => project.id));
    setCollapsedProjectIds(allCollapsed);
  }
  // Persist the boot seed and collapsed set as an effect so StrictMode's
  // double render doesn't double-write localStorage.
  useEffect(() => {
    if (!readBootCollapseSeeded() && snapshot.projects.length > 0) {
      markBootCollapseSeeded();
      saveCollapsedProjectIds(collapsedProjectIds);
    }
  }, [snapshot.projects.length, collapsedProjectIds]);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => loadExpandedProjectIds());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [workspaceOrders, setWorkspaceOrders] = useState<Record<string, string[]>>(() => loadWorkspaceOrders());
  const [sortMode, setSortMode] = useState<ProjectSortMode>(() => loadProjectSortMode());
  const [viewMode, setViewMode] = useState<SidebarViewMode>(() => loadSidebarViewMode());
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<Set<string>>(() =>
    loadCollapsedDateGroupIds()
  );
  const [expandedDateGroups, setExpandedDateGroups] = useState<Set<string>>(() =>
    loadExpandedDateGroupIds()
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  // Per-project actions menu. `mode === "confirm"` swaps the menu in-place
  // for a "Remove '{name}'?" prompt — no separate modal needed. The popover
  // is portaled to <body> because both `.sidebar` and `.project-list` clip
  // overflow; rendering inside the project row would hide the menu.
  const [projectMenuState, setProjectMenuState] = useState<
    { projectId: string; mode: "menu" | "confirm" } | null
  >(null);
  const [projectMenuPos, setProjectMenuPos] = useState<{ top: number; right: number } | null>(null);
  const projectMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuPopoverRef = useRef<HTMLUListElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);

  const closeSortMenu = useCallback((): void => {
    setSortMenuOpen(false);
  }, []);
  useDismissOnOutsideOrEscape(sortMenuAnchorRef, sortMenuOpen, closeSortMenu);

  const closeProjectMenu = useCallback((): void => {
    setProjectMenuState(null);
    setProjectMenuPos(null);
  }, []);
  // Trigger lives in the row; popover is portaled. Both must count as "inside"
  // for the dismiss hook so a click in the popover doesn't immediately close it.
  useDismissOnOutsideOrEscape(
    projectMenuTriggerRef,
    projectMenuState !== null,
    closeProjectMenu,
    projectMenuPopoverRef
  );

  useLayoutEffect(() => {
    if (projectMenuState === null) {
      setProjectMenuPos(null);
      return;
    }
    const trigger = projectMenuTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setProjectMenuPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right)
    });
  }, [projectMenuState]);

  const orderedProjects = useMemo(
    () => sortProjectsBy(snapshot.projects, sortMode, projectOrder),
    [snapshot.projects, sortMode, projectOrder]
  );

  const handleSelectSortMode = useCallback(
    (mode: ProjectSortMode): void => {
      if (mode !== sortMode) {
        setSortMode(mode);
        saveProjectSortMode(mode);
      }
      setSortMenuOpen(false);
    },
    [sortMode]
  );

  const handleSelectViewMode = useCallback(
    (mode: SidebarViewMode): void => {
      if (mode !== viewMode) {
        setViewMode(mode);
        saveSidebarViewMode(mode);
      }
    },
    [viewMode]
  );

  // Workspaces without any matching session in the snapshot can't be opened
  // (a grid pane needs a sessionId). The dashboard query's gap-filler
  // guarantees every workspace that has at least one session row in SQLite
  // also has its latest session in `snapshot.sessions`; anything still
  // missing is a truly orphaned workspace (session insert failed mid-launch).
  // Hide those rows so the click is never dead.
  const workspaceIdsWithSessions = useMemo(() => {
    const ids = new Set<string>();
    for (const session of snapshot.sessions) {
      ids.add(session.workspaceId);
    }
    return ids;
  }, [snapshot.sessions]);

  // Flat, date-bucketed list for the "sessions" view mode — every non-archived
  // workspace that has a session, regardless of project.
  const dateGroups = useMemo(
    () =>
      groupWorkspacesByDate(
        snapshot.workspaces.filter(
          (workspace) =>
            workspace.state !== "archived" && workspaceIdsWithSessions.has(workspace.id)
        )
      ),
    [snapshot.workspaces, workspaceIdsWithSessions]
  );

  const workspaceTokenMap = useMemo(() => {
    const map = new Map<string, { input: number; output: number; cached: number }>();
    for (const session of snapshot.sessions) {
      const tokens = session.tokens;
      if (!tokens) continue;
      const prev = map.get(session.workspaceId) ?? { input: 0, output: 0, cached: 0 };
      map.set(session.workspaceId, {
        input: prev.input + tokens.input,
        output: prev.output + tokens.output,
        cached: prev.cached + tokens.cacheRead + tokens.cacheWrite
      });
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

  const toggleProjectExpansion = useCallback(
    (projectId: string): void => {
      const next = new Set(expandedProjectIds);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      setExpandedProjectIds(next);
      saveExpandedProjectIds(next);
    },
    [expandedProjectIds]
  );

  const toggleDateGroupVisibility = useCallback(
    (key: string): void => {
      const next = new Set(collapsedDateGroups);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      setCollapsedDateGroups(next);
      saveCollapsedDateGroupIds(next);
    },
    [collapsedDateGroups]
  );

  const toggleDateGroupExpansion = useCallback(
    (key: string): void => {
      const next = new Set(expandedDateGroups);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      setExpandedDateGroups(next);
      saveExpandedDateGroupIds(next);
    },
    [expandedDateGroups]
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
          if (sortMode !== "manual") {
            setSortMode("manual");
            saveProjectSortMode("manual");
          }
          setProjectOrder(next);
          saveProjectOrder(next);
        }
      }
      setDraggingId(null);
      setDragOverId(null);
    },
    [draggingId, sortMode]
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
    event.dataTransfer.setData(WORKSPACE_DRAG_MIME, workspaceId);
    event.dataTransfer.effectAllowed = "copyMove";
    setDraggingWorkspaceId(workspaceId);
    onWorkspaceDragStart?.(workspaceId);
  }, [onWorkspaceDragStart]);

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
    onWorkspaceDragEnd?.();
  }, [onWorkspaceDragEnd]);

  const nameplateDate = useMemo(() => formatNameplateDate(), []);

  return (
    <aside className="sidebar" data-loading={loadState === "loading" ? "true" : undefined}>
      <div className="window-controls" data-window-drag />
      <div className="sidebar-nameplate" aria-hidden="true">
        <div className="sidebar-nameplate-line">
          <span className="sidebar-nameplate-mark">argmax</span>
          <span className="sidebar-nameplate-slash">//</span>
        </div>
        <div className="sidebar-nameplate-sub">{nameplateDate} · {APP_VERSION_LABEL}</div>
      </div>
      <nav className="rail-nav" aria-label="Primary">
        <button
          className="rail-nav-item rail-nav-cta"
          type="button"
          title="New session"
          aria-label="New session"
          onClick={onOpenLauncher}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Plus size={14} />
          </span>
          <span className="rail-nav-label">New session</span>
        </button>
      </nav>

      <div className="project-list">
        <div className="rail-heading">
          <p className="rail-label">
            <span className="rail-label-text">{viewMode === "sessions" ? "Sessions" : "Projects"}</span>
          </p>
          <div className="project-picker-anchor rail-sort-anchor" ref={sortMenuAnchorRef}>
            <button
              className="small-icon"
              type="button"
              title="Sidebar view options"
              aria-label="Sidebar view options"
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
              onClick={() => setSortMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={14} />
            </button>
            {sortMenuOpen && (
              <ul
                className="project-picker-popover rail-sort-popover"
                role="menu"
                aria-label="Sidebar view options"
              >
                <li className="rail-sort-group-label" role="presentation">
                  Group by
                </li>
                {VIEW_MODE_OPTIONS.map((option) => {
                  const isActive = option.value === viewMode;
                  return (
                    <li key={option.value} role="none">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={isActive}
                        className="project-picker-item"
                        title={option.description}
                        onClick={() => handleSelectViewMode(option.value)}
                      >
                        <span className="rail-sort-check" aria-hidden="true">
                          {isActive ? <Check size={14} /> : null}
                        </span>
                        {option.label}
                      </button>
                    </li>
                  );
                })}
                {viewMode === "projects" ? (
                  <>
                    <li className="rail-sort-divider" role="separator" />
                    <li className="rail-sort-group-label" role="presentation">
                      Sort projects
                    </li>
                    {SORT_MODE_OPTIONS.map((option) => {
                      const isActive = option.value === sortMode;
                      return (
                        <li key={option.value} role="none">
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={isActive}
                            className="project-picker-item"
                            title={option.description}
                            onClick={() => handleSelectSortMode(option.value)}
                          >
                            <span className="rail-sort-check" aria-hidden="true">
                              {isActive ? <Check size={14} /> : null}
                            </span>
                            {option.label}
                          </button>
                        </li>
                      );
                    })}
                  </>
                ) : null}
              </ul>
            )}
          </div>
          <button className="small-icon" type="button" title="Add Project" aria-label="Add Project" onClick={onAddProject}>
            <Plus size={14} />
          </button>
        </div>
        {viewMode === "sessions"
          ? dateGroups.map((group) => {
              const isCollapsed = collapsedDateGroups.has(group.key);
              const totalCount = group.items.length;
              const isExpanded = expandedDateGroups.has(group.key);
              const selectedIndex = selectedWorkspaceId
                ? group.items.findIndex((workspace) => workspace.id === selectedWorkspaceId)
                : -1;
              const forceExpand = selectedIndex >= SIDEBAR_SESSION_LIMIT;
              const showAll = isExpanded || forceExpand;
              const visibleItems = showAll ? group.items : group.items.slice(0, SIDEBAR_SESSION_LIMIT);
              const hiddenCount = totalCount - visibleItems.length;
              const hasOverflow = totalCount > SIDEBAR_SESSION_LIMIT;
              return (
                <div
                  className="project-group session-date-group"
                  data-collapsed={isCollapsed ? "true" : undefined}
                  key={group.key}
                >
                  <div
                    className="project-row session-date-row"
                    onClick={() => toggleDateGroupVisibility(group.key)}
                  >
                    <span className="project-name session-date-label">
                      <span className="project-name-text">{group.label}</span>
                    </span>
                    {/* Empty actions column so the chevron lands in the same
                        right-edge slot as a project row's visibility chevron. */}
                    <span aria-hidden="true" />
                    <button
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "Show" : "Hide"} ${group.label} sessions`}
                      className="project-visibility"
                      title={`${isCollapsed ? "Show" : "Hide"} Sessions`}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDateGroupVisibility(group.key);
                      }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                  {isCollapsed ? null : (
                    <>
                      {visibleItems.map((workspace) => (
                          <div
                            key={workspace.id}
                            className="session-row-wrap"
                          >
                            <SidebarSessionRow
                              workspace={workspace}
                              workspaceTokens={workspaceTokenMap.get(workspace.id) ?? null}
                              isSelected={selectedWorkspaceId === workspace.id}
                              isOpenInGrid={openWorkspaceIds.has(workspace.id)}
                              canDragToGrid={canDragWorkspaceToGrid}
                              onOpenWorkspaceChat={onOpenWorkspaceChat}
                              onArchiveWorkspace={onArchiveWorkspace}
                              onOpenInIde={onOpenInIde}
                              onTogglePin={onToggleWorkspacePinned}
                              onRename={onRenameWorkspace}
                              onWorkspaceDragStart={onWorkspaceDragStart}
                              onWorkspaceDragEnd={onWorkspaceDragEnd}
                              detectedIdes={detectedIdes}
                              defaultIde={defaultIde}
                              showTokens={showSessionTokens}
                            />
                          </div>
                      ))}
                      {hasOverflow ? (
                        <button
                          type="button"
                          className="sidebar-show-more"
                          aria-expanded={showAll}
                          aria-label={
                            showAll
                              ? `Show fewer ${group.label} sessions`
                              : `Show ${hiddenCount} more ${group.label} sessions`
                          }
                          onClick={() => toggleDateGroupExpansion(group.key)}
                        >
                          {showAll ? "Show less" : `Show ${hiddenCount} more`}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })
          : orderedProjects.map((project) => {
          const manualOrder = workspaceOrders[project.id] ?? [];
          const liveWorkspaces = sortWorkspaceGroup(
            snapshot.workspaces.filter(
              (workspace) =>
                workspace.projectId === project.id &&
                workspace.state !== "archived" &&
                workspaceIdsWithSessions.has(workspace.id)
            ),
            manualOrder
          );
          const projectWorkspaces = liveWorkspaces;
          const orderedWorkspaceIds = projectWorkspaces.map((workspace) => workspace.id);
          const isCollapsed = collapsedProjectIds.has(project.id);
          const totalCount = projectWorkspaces.length;
          const isExpanded = expandedProjectIds.has(project.id);
          const selectedIndex = selectedWorkspaceId
            ? projectWorkspaces.findIndex((workspace) => workspace.id === selectedWorkspaceId)
            : -1;
          const forceExpand = selectedIndex >= SIDEBAR_SESSION_LIMIT;
          const showAll = isExpanded || forceExpand;
          const visibleWorkspaces = showAll
            ? projectWorkspaces
            : projectWorkspaces.slice(0, SIDEBAR_SESSION_LIMIT);
          const hiddenCount = totalCount - visibleWorkspaces.length;
          const hasOverflow = totalCount > SIDEBAR_SESSION_LIMIT;
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
              <div
                className="project-row"
                onClick={() => toggleProjectVisibility(project.id)}
              >
                <button
                  aria-current={selectedProjectId === project.id && !selectedWorkspaceId ? "true" : undefined}
                  className={
                    selectedProjectId === project.id && !selectedWorkspaceId ? "project-name active" : "project-name"
                  }
                  type="button"
                  onClick={(event) => {
                    // The project name opens the project; the row-level click
                    // (and the chevron) handle collapse, so stop this from
                    // bubbling up and immediately toggling visibility back.
                    event.stopPropagation();
                    if (selectedProjectId === project.id && !selectedWorkspaceId) {
                      toggleProjectVisibility(project.id);
                      return;
                    }
                    expandProjectVisibility(project.id);
                    onOpenProject(project.id);
                  }}
                >
                  <span className="project-name-text">{project.name}</span>
                </button>
                {onRemoveProject ? (
                  <div className="project-picker-anchor project-actions-anchor">
                    <button
                      ref={projectMenuState?.projectId === project.id ? projectMenuTriggerRef : null}
                      className="small-icon project-actions-trigger"
                      type="button"
                      title={`Actions for ${project.name}`}
                      aria-label={`Actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={projectMenuState?.projectId === project.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (projectMenuState?.projectId === project.id) {
                          closeProjectMenu();
                          return;
                        }
                        // Stash the trigger up front so the layout effect can
                        // measure it on the same render pass.
                        projectMenuTriggerRef.current = event.currentTarget;
                        setProjectMenuState({ projectId: project.id, mode: "menu" });
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                ) : null}
                <button
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Show" : "Hide"} ${project.name} sessions`}
                  className="project-visibility"
                  title={`${isCollapsed ? "Show" : "Hide"} Sessions`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleProjectVisibility(project.id);
                  }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {isCollapsed ? null : (
                <>
                  {visibleWorkspaces.map((workspace) => (
                      <div
                        key={workspace.id}
                        className={`session-row-wrap${draggingWorkspaceId === workspace.id ? " dragging" : ""}`}
                        draggable={Boolean(onToggleWorkspacePinned) && canDragWorkspaceToGrid}
                        onDragStart={(event) => handleWorkspaceDragStart(event, workspace.id)}
                        onDragOver={handleWorkspaceDragOver}
                        onDrop={(event) =>
                          handleWorkspaceDrop(event, project.id, workspace.id, orderedWorkspaceIds)
                        }
                        onDragEnd={handleWorkspaceDragEnd}
                      >
                        <SidebarSessionRow
                          workspace={workspace}
                          workspaceTokens={workspaceTokenMap.get(workspace.id) ?? null}
                          isSelected={selectedWorkspaceId === workspace.id}
                          isOpenInGrid={openWorkspaceIds.has(workspace.id)}
                          canDragToGrid={canDragWorkspaceToGrid}
                          onOpenWorkspaceChat={onOpenWorkspaceChat}
                          onArchiveWorkspace={onArchiveWorkspace}
                          onOpenInIde={onOpenInIde}
                          onTogglePin={onToggleWorkspacePinned}
                          onRename={onRenameWorkspace}
                          onWorkspaceDragStart={onWorkspaceDragStart}
                          onWorkspaceDragEnd={onWorkspaceDragEnd}
                          detectedIdes={detectedIdes}
                          defaultIde={defaultIde}
                          showTokens={showSessionTokens}
                        />
                      </div>
                  ))}
                  {hasOverflow ? (
                    <button
                      type="button"
                      className="sidebar-show-more"
                      aria-expanded={showAll}
                      aria-label={
                        showAll
                          ? `Show fewer ${project.name} sessions`
                          : `Show ${hiddenCount} more ${project.name} sessions`
                      }
                      onClick={() => toggleProjectExpansion(project.id)}
                    >
                      {showAll ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>

      {projectMenuState && projectMenuPos
        ? (() => {
            const activeProject = snapshot.projects.find((p) => p.id === projectMenuState.projectId);
            if (!activeProject || !onRemoveProject) return null;
            return createPortal(
              <ul
                ref={projectMenuPopoverRef}
                className="project-picker-popover project-actions-popover"
                role="menu"
                aria-label={`${activeProject.name} actions`}
                style={{
                  position: "fixed",
                  top: projectMenuPos.top,
                  right: projectMenuPos.right,
                  left: "auto",
                  bottom: "auto"
                }}
              >
                {projectMenuState.mode === "menu" ? (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="project-picker-item project-actions-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        setProjectMenuState({ projectId: activeProject.id, mode: "confirm" });
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Remove project
                    </button>
                  </li>
                ) : (
                  <li role="none">
                    <p className="project-actions-confirm-text">
                      Forget <strong>{activeProject.name}</strong> and all its sessions? Files on disk are untouched.
                    </p>
                    <div className="project-actions-confirm-buttons">
                      <button
                        type="button"
                        className="project-picker-item project-actions-confirm-cancel"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeProjectMenu();
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="project-picker-item project-actions-destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeProjectMenu();
                          onRemoveProject(activeProject.id);
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Remove
                      </button>
                    </div>
                  </li>
                )}
              </ul>,
              document.body
            );
          })()
        : null}

      <div className="sidebar-footer">
        <div className="identity-chip" data-state={loadState}>
          <span className="identity-avatar" aria-hidden="true">
            <Mascot size={26} className="identity-avatar-mascot" />
          </span>
          <span className="identity-meta">
            <span className="identity-name">argmax@local</span>
            <span className="identity-sub">
              <span className="identity-sub-dot" aria-hidden="true" />
              {loadState === "ready" ? "ready" : loadState === "loading" ? "booting" : "issue"}
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
