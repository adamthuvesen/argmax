import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Cpu,
  Info,
  Keyboard,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Settings2,
  Trash2,
  X
} from "lucide-react";
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
import { SCRATCH_PROJECT_ID } from "../../shared/types.js";
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
import { computePriorityEntries } from "../lib/priority.js";
import { Mascot } from "./Mascot.js";
import { SidebarSessionRow, type WorkspaceClickModifiers } from "./SidebarSessionRow.js";

// Markers stored in sessionStorage (cleared on app quit / window close in
// Tauri) so each boot seed fires exactly once per real app launch, not on every
// Sidebar mount. Tests can pre-set a marker when they need to bypass one seed
// without bypassing the other.
const BOOT_COLLAPSE_SEED_KEY = "argmax.sidebar.bootCollapseSeeded";
const BOOT_GROUP_COLLAPSE_SEED_KEY = "argmax.sidebar.bootGroupCollapseSeeded";

function readBootSeeded(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}

function markBootSeeded(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // SecurityError / QuotaExceeded — fall through; worst case we collapse
    // again on the next render, which is harmless.
  }
}

// Pinned and Priority collapse through the same persisted set as the recency
// buckets. `groupWorkspacesByDate` only ever emits today / last-7 / last-30 /
// older, so these keys can't collide with a date bucket.
const PINNED_GROUP_KEY = "pinned";
const PRIORITY_GROUP_KEY = "priority";
const SIDE_CHATS_GROUP_KEY = "side-chats";

// Per-launch behavior: every session group except Pinned starts collapsed, so a
// fresh window opens on the standing pins and nothing else.
const BOOT_COLLAPSED_GROUP_KEYS: readonly string[] = [
  PRIORITY_GROUP_KEY,
  SIDE_CHATS_GROUP_KEY,
  "today",
  "last-7",
  "last-30",
  "older"
];

const VIEW_MODE_OPTIONS: ReadonlyArray<{ value: SidebarViewMode; label: string; description: string }> = [
  { value: "projects", label: "Projects", description: "Group sessions under their project" },
  { value: "sessions", label: "Date", description: "Flat list of all sessions by date" }
];

const SORT_MODE_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string; description: string }> = [
  { value: "recent", label: "Recent activity", description: "Most recently active project first" },
  { value: "alphabetical", label: "Alphabetical (A→Z)", description: "Sort by project name" },
  { value: "manual", label: "Manual", description: "Drag to reorder" }
];

function visibleSidebarItems<T extends { id: string }>(
  items: T[],
  selectedId: string | null,
  expanded: boolean
): T[] {
  if (expanded || items.length <= SIDEBAR_SESSION_LIMIT) {
    return items;
  }

  const compact = items.slice(0, SIDEBAR_SESSION_LIMIT);
  if (!selectedId) {
    return compact;
  }

  const selectedIndex = items.findIndex((item) => item.id === selectedId);
  if (selectedIndex < SIDEBAR_SESSION_LIMIT) {
    return compact;
  }

  const selectedItem = items[selectedIndex];
  return selectedItem ? [...items.slice(0, SIDEBAR_SESSION_LIMIT - 1), selectedItem] : compact;
}

export function Sidebar({
  loadState,
  onAddProject,
  onNewSideChat,
  onArchiveWorkspace,
  onOpenInIde,
  onOpenLauncher,
  onOpenAbout,
  onOpenCommandPalette,
  onOpenDiagnostics,
  onOpenKeyboardShortcuts,
  onOpenProviders,
  onOpenProject,
  onOpenSettings,
  onOpenWorkspaceChat,
  onRemoveProject,
  onRenameWorkspace,
  onResizeMouseDown,
  onToggleWorkspacePinned,
  onRemoveFromPriority,
  onAddToPriority,
  onClearPriority,
  onSetWorkspaceIcon,
  showPriority,
  onWorkspaceDragStart,
  onWorkspaceDragEnd,
  selectedProjectId,
  selectedWorkspaceId,
  openWorkspaceIds,
  canDragWorkspaceToGrid,
  snapshot,
  detectedIdes,
  defaultIde,
  showSessionTokens,
  collapsed,
  onPeekLeave
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  /** Opens the launcher pre-set to side-chat mode. */
  onNewSideChat?: () => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  onOpenLauncher: () => void;
  onOpenAbout: () => void;
  onOpenCommandPalette: () => void;
  onOpenDiagnostics: () => void;
  onOpenKeyboardShortcuts: () => void;
  onOpenProviders: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onOpenWorkspaceChat: (workspaceId: string, modifiers: WorkspaceClickModifiers) => void;
  onRemoveProject?: (projectId: string) => void;
  onRenameWorkspace?: (workspaceId: string, taskLabel: string) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  onToggleWorkspacePinned?: (workspaceId: string, pinned: boolean) => void;
  /** Right-click "Remove from priority" on a Priority row — dismisses it until new attention. */
  onRemoveFromPriority?: (workspaceId: string) => void;
  /** Right-click "Add to priority" on any other row — floats it manually. */
  onAddToPriority?: (workspaceId: string) => void;
  /** "Clear" on the Priority header dismisses every row the section holds. */
  onClearPriority?: (workspaceIds: string[]) => void;
  /** Right-click "Edit Icon" on any row — both values null clears the glyph. */
  onSetWorkspaceIcon?: (
    workspaceId: string,
    icon: string | null,
    iconColor: string | null
  ) => void;
  /** Whether the Priority section renders at all (settings toggle). */
  showPriority: boolean;
  /** Notifies the parent that a sidebar drag started carrying this workspace. */
  onWorkspaceDragStart?: (workspaceId: string) => void;
  /** Notifies the parent that a sidebar drag finished (drop or cancel). */
  onWorkspaceDragEnd?: () => void;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  openWorkspaceIds: Set<string>;
  canDragWorkspaceToGrid: boolean;
  snapshot: DashboardSnapshot;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  showSessionTokens: boolean;
  /** Whether the sidebar is collapsed (rendered as a hover-peek overlay). */
  collapsed?: boolean;
  /** Pointer left the sidebar while collapsed — parent should end the peek. */
  onPeekLeave?: () => void;
}): JSX.Element {
  // Per-launch behavior: every project starts collapsed so no sessions are
  // visible on app start. After the first non-empty snapshot, we set a
  // sessionStorage marker so subsequent re-mounts within the same renderer
  // process (e.g. hot-reload) respect the persisted state and don't
  // re-collapse projects the user has since expanded.
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() =>
    readBootSeeded(BOOT_COLLAPSE_SEED_KEY) ? loadCollapsedProjectIds() : new Set()
  );
  const startupCollapseInitializedRef = useRef(readBootSeeded(BOOT_COLLAPSE_SEED_KEY));
  if (!startupCollapseInitializedRef.current && snapshot.projects.length > 0) {
    startupCollapseInitializedRef.current = true;
    const allCollapsed = new Set(snapshot.projects.map((project) => project.id));
    setCollapsedProjectIds(allCollapsed);
  }
  // Persist the boot seed and collapsed set as an effect so StrictMode's
  // double render doesn't double-write localStorage.
  useEffect(() => {
    if (!readBootSeeded(BOOT_COLLAPSE_SEED_KEY) && snapshot.projects.length > 0) {
      markBootSeeded(BOOT_COLLAPSE_SEED_KEY);
      saveCollapsedProjectIds(collapsedProjectIds);
    }
  }, [snapshot.projects.length, collapsedProjectIds]);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => loadExpandedProjectIds());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [workspaceOrders, setWorkspaceOrders] = useState<Record<string, string[]>>(() => loadWorkspaceOrders());
  const [sortMode, setSortMode] = useState<ProjectSortMode>(() => loadProjectSortMode());
  const [viewMode, setViewMode] = useState<SidebarViewMode>(() => loadSidebarViewMode());
  // Pinned is the only group that survives a launch expanded. Mid-session
  // toggles persist as usual, and the next launch collapses everything but
  // Pinned again.
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<Set<string>>(() =>
    readBootSeeded(BOOT_GROUP_COLLAPSE_SEED_KEY)
      ? loadCollapsedDateGroupIds()
      : new Set(BOOT_COLLAPSED_GROUP_KEYS)
  );
  useEffect(() => {
    if (!readBootSeeded(BOOT_GROUP_COLLAPSE_SEED_KEY)) {
      markBootSeeded(BOOT_GROUP_COLLAPSE_SEED_KEY);
      saveCollapsedDateGroupIds(collapsedDateGroups);
    }
  }, [collapsedDateGroups]);
  const [expandedDateGroups, setExpandedDateGroups] = useState<Set<string>>(() =>
    loadExpandedDateGroupIds()
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const [identityMenuOpen, setIdentityMenuOpen] = useState(false);
  const identityMenuAnchorRef = useRef<HTMLDivElement | null>(null);
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

  const closeIdentityMenu = useCallback((): void => {
    setIdentityMenuOpen(false);
  }, []);
  useDismissOnOutsideOrEscape(identityMenuAnchorRef, identityMenuOpen, closeIdentityMenu);

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
    // The hidden scratch project never renders as a project group: its
    // side chats live in the dedicated bottom section instead.
    () =>
      sortProjectsBy(
        snapshot.projects.filter((project) => project.id !== SCRATCH_PROJECT_ID),
        sortMode,
        projectOrder
      ),
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

  // Workspaces that need the user right now (approval, blocked, failed,
  // review-ready) float into the Priority section, directly under Pinned.
  // A row lives in exactly one section. Pinned wins: a pin keeps the row
  // in Pinned even when it would otherwise qualify for Priority. Unpinned
  // Priority rows leave their date/project group and drop back when
  // resolved, dismissed, or aged out.
  // `Date.now()` is read inside the memo, so the 24h staleness gate is only
  // re-evaluated when the snapshot changes — consistent with the no-polling
  // rule. An entry that crosses the age line simply drops on the next delta.
  // Popup workspaces (the "More details" mini-sessions) never surface in the
  // sidebar in any section.
  const sidebarWorkspaces = useMemo(
    () => snapshot.workspaces.filter((workspace) => workspace.kind !== "popup"),
    [snapshot.workspaces]
  );

  // Side chats live in their own bottom section and are conversational by
  // nature — they never escalate into the Priority triage list.
  const priorityEntries = useMemo(
    () =>
      showPriority
        ? computePriorityEntries(
            sidebarWorkspaces.filter((workspace) => workspace.kind === "git"),
            snapshot.sessions,
            Date.now()
          )
        : [],
    [showPriority, sidebarWorkspaces, snapshot.sessions]
  );

  // Project-name subtitles (screenshot-style two-line rows) for rows whose
  // group doesn't already name the project: Priority, Pinned, and the flat
  // date view. Rows under a project group skip it — the header says it.
  // Tied to the Priority toggle so one setting flips the whole look.
  const projectNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of snapshot.projects) {
      names.set(project.id, project.name);
    }
    return names;
  }, [snapshot.projects]);
  const subtitleFor = useCallback(
    (projectId: string): string | null =>
      showPriority ? projectNameById.get(projectId) ?? null : null,
    [showPriority, projectNameById]
  );

  const priorityWorkspaceIds = useMemo(
    () => new Set(priorityEntries.map((entry) => entry.workspace.id)),
    [priorityEntries]
  );
  // "Add to priority" only makes sense while the section exists.
  const addToPriority = showPriority ? onAddToPriority : undefined;

  // Pinned workspaces float into a dedicated section at the very top of the
  // list, above Priority, the date buckets (sessions view), and the project
  // groups (projects view). They're pulled out of their normal bucket while
  // pinned and drop straight back the moment they're unpinned. Shared by both
  // view modes.
  const pinnedWorkspaces = useMemo(
    () =>
      sidebarWorkspaces
        .filter(
          (workspace) =>
            workspace.pinned &&
            workspace.state !== "archived" &&
            workspaceIdsWithSessions.has(workspace.id)
        )
        .sort((a, b) => {
          if (a.lastActivityAt === b.lastActivityAt) return 0;
          return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
        }),
    [sidebarWorkspaces, workspaceIdsWithSessions]
  );

  // Flat, date-bucketed list for the "sessions" view mode — every non-archived,
  // unpinned workspace that has a session, regardless of project. Pinned ones
  // live in the pinned section above instead.
  const dateGroups = useMemo(
    () =>
      groupWorkspacesByDate(
        sidebarWorkspaces.filter(
          (workspace) =>
            workspace.kind === "git" &&
            !workspace.pinned &&
            workspace.state !== "archived" &&
            !priorityWorkspaceIds.has(workspace.id) &&
            workspaceIdsWithSessions.has(workspace.id)
        )
      ),
    [sidebarWorkspaces, priorityWorkspaceIds, workspaceIdsWithSessions]
  );

  // Side chats keep their own section at the very bottom, below the date
  // buckets and project groups, in both view modes. Pinned and Priority still
  // win — a row lives in exactly one section.
  const sideChatWorkspaces = useMemo(
    () =>
      sidebarWorkspaces
        .filter(
          (workspace) =>
            workspace.kind === "scratch" &&
            !workspace.pinned &&
            workspace.state !== "archived" &&
            !priorityWorkspaceIds.has(workspace.id) &&
            workspaceIdsWithSessions.has(workspace.id)
        )
        .sort((a, b) => {
          if (a.lastActivityAt === b.lastActivityAt) return 0;
          return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
        }),
    [sidebarWorkspaces, priorityWorkspaceIds, workspaceIdsWithSessions]
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

  // A newly launched (or newly selected) session must not vanish into a
  // collapsed section: expand the group that hosts the selected row. Keyed on
  // the id *changing* — once revealed, the user may still collapse the group
  // over a selected row without this snapping it back open.
  const lastExpandedForWorkspaceId = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedWorkspaceId || lastExpandedForWorkspaceId.current === selectedWorkspaceId) return;
    const workspace = sidebarWorkspaces.find((candidate) => candidate.id === selectedWorkspaceId);
    if (!workspace || workspace.state === "archived") return;
    lastExpandedForWorkspaceId.current = selectedWorkspaceId;
    const groupKey = workspace.pinned
      ? PINNED_GROUP_KEY
      : priorityWorkspaceIds.has(workspace.id)
        ? PRIORITY_GROUP_KEY
        : workspace.kind === "scratch"
          ? SIDE_CHATS_GROUP_KEY
          : viewMode === "sessions"
            ? dateGroups.find((group) => group.items.some((item) => item.id === workspace.id))?.key ??
              null
            : null;
    if (groupKey && collapsedDateGroups.has(groupKey)) {
      const next = new Set(collapsedDateGroups);
      next.delete(groupKey);
      setCollapsedDateGroups(next);
      saveCollapsedDateGroupIds(next);
    }
    if (viewMode === "projects" && workspace.kind === "git") {
      expandProjectVisibility(workspace.projectId);
    }
  }, [
    collapsedDateGroups,
    dateGroups,
    expandProjectVisibility,
    priorityWorkspaceIds,
    selectedWorkspaceId,
    sidebarWorkspaces,
    viewMode
  ]);

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

  // Every sidebar section header (Pinned, Priority, recency buckets) carries
  // the same chevron, tucked inside the label so it hugs the word.
  const renderCollapseButton = useCallback(
    (groupKey: string, label: string, isCollapsed: boolean): JSX.Element => (
      <button
        aria-expanded={!isCollapsed}
        aria-label={`${isCollapsed ? "Show" : "Hide"} ${label} sessions`}
        className="project-visibility"
        title={`${isCollapsed ? "Show" : "Hide"} Sessions`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggleDateGroupVisibility(groupKey);
        }}
      >
        <ChevronRight size={14} />
      </button>
    ),
    [toggleDateGroupVisibility]
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

  const identitySubLabel = loadState === "loading"
    ? "Booting..."
    : loadState === "error"
      ? "Needs attention"
      : APP_VERSION_LABEL;
  const runIdentityAction = useCallback((action: () => void): void => {
    setIdentityMenuOpen(false);
    action();
  }, []);

  // The group labels already name the list, so there is no separate section
  // title. The "…" / "+" cluster rides the first list header instead: the
  // newest recency bucket in sessions view, the "Projects" header in projects
  // view. It falls back to a quiet label-less strip only when sessions view
  // has no bucket to host it.
  const leadDateGroupKey = viewMode === "sessions" ? dateGroups[0]?.key ?? null : null;
  const pinnedCollapsed = collapsedDateGroups.has(PINNED_GROUP_KEY);
  const priorityCollapsed = collapsedDateGroups.has(PRIORITY_GROUP_KEY);
  const sidebarActions = (
    <div className="rail-actions" onClick={(event) => event.stopPropagation()}>
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
  );
  const sideChatsCollapsed = collapsedDateGroups.has(SIDE_CHATS_GROUP_KEY);
  const sideChatsExpanded = expandedDateGroups.has(SIDE_CHATS_GROUP_KEY);
  const visibleSideChats = visibleSidebarItems(sideChatWorkspaces, selectedWorkspaceId, sideChatsExpanded);
  const hiddenSideChatCount = sideChatWorkspaces.length - visibleSideChats.length;
  // Rendered below the date buckets (sessions view) and project groups
  // (projects view): side chats are their own bottom section in both.
  const sideChatsSection =
    onNewSideChat || sideChatWorkspaces.length > 0 ? (
      <div
        className="project-group session-date-group"
        data-collapsed={sideChatsCollapsed ? "true" : undefined}
      >
        <div
          className="project-row session-date-row"
          onClick={() => toggleDateGroupVisibility(SIDE_CHATS_GROUP_KEY)}
        >
          <span className="project-name session-date-label">
            <span className="project-name-text">Side chats</span>
            {renderCollapseButton(SIDE_CHATS_GROUP_KEY, "Side chats", sideChatsCollapsed)}
          </span>
          {onNewSideChat ? (
            <span className="rail-actions" onClick={(event) => event.stopPropagation()}>
              <button
                className="small-icon"
                type="button"
                title="New side chat — a chat without a repository"
                aria-label="New side chat"
                onClick={onNewSideChat}
              >
                <Plus size={14} />
              </button>
            </span>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
        {sideChatsCollapsed ? null : (
          <>
            {visibleSideChats.map((workspace) => (
              <div key={workspace.id} className="session-row-wrap">
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
                  onSetIcon={onSetWorkspaceIcon}
                  onAddToPriority={addToPriority}
                  onWorkspaceDragStart={onWorkspaceDragStart}
                  onWorkspaceDragEnd={onWorkspaceDragEnd}
                  detectedIdes={detectedIdes}
                  defaultIde={defaultIde}
                  showTokens={showSessionTokens}
                />
              </div>
            ))}
            {sideChatWorkspaces.length > SIDEBAR_SESSION_LIMIT ? (
              <button
                type="button"
                className="sidebar-show-more"
                aria-expanded={sideChatsExpanded}
                aria-label={
                  sideChatsExpanded
                    ? "Show fewer side chats"
                    : `Show ${hiddenSideChatCount} more side chats`
                }
                onClick={() => toggleDateGroupExpansion(SIDE_CHATS_GROUP_KEY)}
              >
                {sideChatsExpanded ? "Show less" : `Show ${hiddenSideChatCount} more`}
              </button>
            ) : null}
          </>
        )}
      </div>
    ) : null;

  return (
    <aside
      className="sidebar"
      data-loading={loadState === "loading" ? "true" : undefined}
      onMouseLeave={collapsed ? onPeekLeave : undefined}
    >
      <div className="window-controls" data-window-drag />
      <nav className="rail-nav" aria-label="Primary">
        <button
          className="rail-nav-item rail-nav-cta"
          type="button"
          title="New Agent"
          aria-label="New Agent"
          onClick={onOpenLauncher}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Plus size={14} />
          </span>
          <span className="rail-nav-label">New Agent</span>
          <kbd aria-hidden="true">⌘N</kbd>
        </button>
        <button
          className="rail-nav-item"
          type="button"
          title="Search"
          aria-label="Search"
          onClick={onOpenCommandPalette}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Search size={14} />
          </span>
          <span className="rail-nav-label">Search</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
        <button
          className="rail-nav-item"
          type="button"
          title="Customize"
          aria-label="Customize"
          onClick={onOpenSettings}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Settings2 size={14} />
          </span>
          <span className="rail-nav-label">Customize</span>
          <kbd aria-hidden="true">⌘,</kbd>
        </button>
      </nav>

      <div className="project-list">
        {viewMode === "sessions" && leadDateGroupKey === null ? (
          <div className="rail-heading">{sidebarActions}</div>
        ) : null}
        {/* Pinned sits at the very top, above Priority: a pin is a standing
            user choice, while Priority is transient triage. */}
        {pinnedWorkspaces.length > 0 ? (
          <div
            className="project-group session-date-group session-pinned-group"
            data-collapsed={pinnedCollapsed ? "true" : undefined}
          >
            <div
              className="project-row session-date-row session-pinned-row"
              onClick={() => toggleDateGroupVisibility(PINNED_GROUP_KEY)}
            >
              <span className="project-name session-date-label session-pinned-label">
                <span className="project-name-text">Pinned</span>
                {renderCollapseButton(PINNED_GROUP_KEY, "Pinned", pinnedCollapsed)}
              </span>
              <span aria-hidden="true" />
            </div>
            {pinnedCollapsed ? null : pinnedWorkspaces.map((workspace) => (
              <div key={workspace.id} className="session-row-wrap">
                <SidebarSessionRow
                  workspace={workspace}
                  subtitle={subtitleFor(workspace.projectId)}
                  workspaceTokens={workspaceTokenMap.get(workspace.id) ?? null}
                  isSelected={selectedWorkspaceId === workspace.id}
                  isOpenInGrid={openWorkspaceIds.has(workspace.id)}
                  canDragToGrid={canDragWorkspaceToGrid}
                  onOpenWorkspaceChat={onOpenWorkspaceChat}
                  onArchiveWorkspace={onArchiveWorkspace}
                  onOpenInIde={onOpenInIde}
                  onTogglePin={onToggleWorkspacePinned}
                  onRename={onRenameWorkspace}
                  onSetIcon={onSetWorkspaceIcon}
                  onWorkspaceDragStart={onWorkspaceDragStart}
                  onWorkspaceDragEnd={onWorkspaceDragEnd}
                  detectedIdes={detectedIdes}
                  defaultIde={defaultIde}
                  showTokens={showSessionTokens}
                />
              </div>
            ))}
          </div>
        ) : null}
        {priorityEntries.length > 0 ? (
          <div
            className="project-group session-date-group session-priority-group"
            data-collapsed={priorityCollapsed ? "true" : undefined}
          >
            <div
              className="project-row session-date-row session-priority-row"
              onClick={() => toggleDateGroupVisibility(PRIORITY_GROUP_KEY)}
            >
              <span className="project-name session-date-label session-priority-label">
                <span className="project-name-text">Priority</span>
                {renderCollapseButton(PRIORITY_GROUP_KEY, "Priority", priorityCollapsed)}
              </span>
              {onClearPriority ? (
                <button
                  className="session-priority-clear"
                  type="button"
                  title="Clear priority"
                  aria-label="Clear priority"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClearPriority(priorityEntries.map((entry) => entry.workspace.id));
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
            {priorityCollapsed ? null : priorityEntries.map((entry) => (
              <div key={entry.workspace.id} className="session-row-wrap">
                <SidebarSessionRow
                  workspace={entry.workspace}
                  subtitle={subtitleFor(entry.workspace.projectId)}
                  workspaceTokens={workspaceTokenMap.get(entry.workspace.id) ?? null}
                  isSelected={selectedWorkspaceId === entry.workspace.id}
                  isOpenInGrid={openWorkspaceIds.has(entry.workspace.id)}
                  canDragToGrid={canDragWorkspaceToGrid}
                  onOpenWorkspaceChat={onOpenWorkspaceChat}
                  onArchiveWorkspace={onArchiveWorkspace}
                  onOpenInIde={onOpenInIde}
                  onTogglePin={onToggleWorkspacePinned}
                  onRename={onRenameWorkspace}
                  onSetIcon={onSetWorkspaceIcon}
                  onRemoveFromPriority={onRemoveFromPriority}
                  priorityAttention={entry.attention ?? undefined}
                  onWorkspaceDragStart={onWorkspaceDragStart}
                  onWorkspaceDragEnd={onWorkspaceDragEnd}
                  detectedIdes={detectedIdes}
                  defaultIde={defaultIde}
                  showTokens={showSessionTokens}
                />
              </div>
            ))}
          </div>
        ) : null}
        {/* Projects view's counterpart to the newest recency header: it names
            the grouping and hosts the … / + cluster on the same line, so
            switching views doesn't shift the list down. */}
        {viewMode === "projects" ? (
          <div className="project-group session-projects-group">
            <div className="project-row session-date-row session-projects-row">
              <span className="project-name session-date-label">
                <span className="project-name-text">Projects</span>
              </span>
              {sidebarActions}
            </div>
          </div>
        ) : null}
        {viewMode === "sessions"
          ? dateGroups.map((group) => {
              const isCollapsed = collapsedDateGroups.has(group.key);
              const totalCount = group.items.length;
              const isExpanded = expandedDateGroups.has(group.key);
              const showAll = isExpanded;
              const visibleItems = visibleSidebarItems(group.items, selectedWorkspaceId, showAll);
              const hiddenCount = totalCount - visibleItems.length;
              const hasOverflow = totalCount > SIDEBAR_SESSION_LIMIT;
              const isLead = group.key === leadDateGroupKey;
              return (
                <div
                  className="project-group session-date-group"
                  data-collapsed={isCollapsed ? "true" : undefined}
                  key={group.key}
                >
                  <div
                    className={`project-row session-date-row${isLead ? " session-date-row-lead" : ""}`}
                    onClick={() => toggleDateGroupVisibility(group.key)}
                  >
                    {/* The label and its collapse chevron are one cluster on the
                        left, so the chevron reads as part of the label. The
                        newest bucket doubles as the list header and also hosts
                        the sidebar actions on the right. */}
                    <span className="project-name session-date-label">
                      <span className="project-name-text">{group.label}</span>
                      {renderCollapseButton(group.key, group.label, isCollapsed)}
                    </span>
                    {isLead ? sidebarActions : <span aria-hidden="true" />}
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
                            subtitle={subtitleFor(workspace.projectId)}
                            workspaceTokens={workspaceTokenMap.get(workspace.id) ?? null}
                            isSelected={selectedWorkspaceId === workspace.id}
                            isOpenInGrid={openWorkspaceIds.has(workspace.id)}
                            canDragToGrid={canDragWorkspaceToGrid}
                            onOpenWorkspaceChat={onOpenWorkspaceChat}
                            onArchiveWorkspace={onArchiveWorkspace}
                            onOpenInIde={onOpenInIde}
                            onTogglePin={onToggleWorkspacePinned}
                            onRename={onRenameWorkspace}
                            onSetIcon={onSetWorkspaceIcon}
                            onAddToPriority={addToPriority}
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
                    !workspace.pinned &&
                    workspace.projectId === project.id &&
                    workspace.state !== "archived" &&
                    !priorityWorkspaceIds.has(workspace.id) &&
                    workspaceIdsWithSessions.has(workspace.id)
                ),
                manualOrder
              );
              const projectWorkspaces = liveWorkspaces;
              const orderedWorkspaceIds = projectWorkspaces.map((workspace) => workspace.id);
              const isCollapsed = collapsedProjectIds.has(project.id);
              const totalCount = projectWorkspaces.length;
              const isExpanded = expandedProjectIds.has(project.id);
              const showAll = isExpanded;
              const visibleWorkspaces = visibleSidebarItems(projectWorkspaces, selectedWorkspaceId, showAll);
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
                        onSetIcon={onSetWorkspaceIcon}
                        onAddToPriority={addToPriority}
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
        {sideChatsSection}
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
        <div className="project-picker-anchor identity-menu-anchor" ref={identityMenuAnchorRef}>
          <button
            className="identity-chip identity-chip-button"
            data-state={loadState}
            type="button"
            aria-label="Argmax menu"
            aria-haspopup="menu"
            aria-expanded={identityMenuOpen}
            onClick={() => setIdentityMenuOpen((open) => !open)}
          >
            <span className="identity-avatar" aria-hidden="true">
              <Mascot size={24} className="identity-avatar-mascot" />
            </span>
            <span className="identity-meta">
              <span className="identity-name">Argmax</span>
              {identitySubLabel ? (
                <span className="identity-sub">{identitySubLabel}</span>
              ) : null}
            </span>
            <ChevronDown className="identity-menu-chevron" size={14} aria-hidden="true" />
          </button>
          {identityMenuOpen ? (
            <ul className="project-picker-popover identity-menu-popover" role="menu" aria-label="Argmax menu">
              <li className="identity-menu-header" role="presentation">
                <span className="identity-menu-title">Argmax</span>
                <span className="identity-menu-subtitle">Local workspace · {APP_VERSION_LABEL}</span>
              </li>
              <li className="project-picker-divider" role="separator" />
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenCommandPalette)}
                >
                  <Command size={14} aria-hidden="true" />
                  <span>Command Palette</span>
                  <kbd>⌘K</kbd>
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenSettings)}
                >
                  <Settings size={14} aria-hidden="true" />
                  <span>Settings</span>
                  <kbd>⌘,</kbd>
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenProviders)}
                >
                  <Cpu size={14} aria-hidden="true" />
                  <span>Providers</span>
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenDiagnostics)}
                >
                  <Activity size={14} aria-hidden="true" />
                  <span>Diagnostics & Logs</span>
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenKeyboardShortcuts)}
                >
                  <Keyboard size={14} aria-hidden="true" />
                  <span>Keyboard Shortcuts</span>
                  <kbd>⌘/</kbd>
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(onOpenAbout)}
                >
                  <Info size={14} aria-hidden="true" />
                  <span>About Argmax</span>
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      </div>
      <div className="sidebar-resizer" aria-hidden="true" onMouseDown={onResizeMouseDown} />
    </aside>
  );
}
