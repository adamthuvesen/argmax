import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  Command,
  Cpu,
  Eraser,
  Folder,
  FolderOpen,
  Globe,
  Info,
  Keyboard,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Settings2,
  Shapes,
  Trash2,
  Workflow
} from "lucide-react";
import {
  useCallback,
  useEffect,
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
import { APP_VERSION } from "../../shared/appVersion.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { PickerLead } from "./PickerLead.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import { isInArchivedSection } from "../lib/archivedSection.js";
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
import { buildSidebarChatTree } from "../lib/sidebarChatTree.js";
import {
  detachSidebarChat,
  loadCollapsedChatIds,
  saveCollapsedChatIds,
  useSidebarChatNesting
} from "../lib/sidebarChatNesting.js";
import { useLauncherSurface } from "../state/launcherSurface.js";
import {
  showCommandPalette,
  showKeyboardCheatSheet,
  showSchedulePage,
  showSettings,
  showUsagePage,
} from "../state/overlays.js";
import { NewArcDialog } from "./arcs/NewArcDialog.js";
import { usePaneGrid } from "../state/paneGrid.js";
import { setSidebarPeek, useSidebarChrome } from "../state/sidebarChrome.js";
import {
  beginWorkspaceDrag,
  endWorkspaceDrag,
  subscribeWorkspacePointerDrag,
  useDraggingWorkspaceId,
  workspaceDragSnapshot
} from "../state/workspaceDrag.js";
import { computePriorityEntries, workingWorkspaceIds } from "../lib/priority.js";
import { computeSnoozeShelf, snoozeTimerDelay } from "../lib/snooze.js";
import { formatSessionIds } from "../lib/sessionIds.js";
import { warmLedgerPagesOnIntent } from "../lib/ledgerPrefetch.js";
import { useUnreadWorkspaceIds } from "../lib/sessionUnread.js";
import { chatSessionByWorkspace } from "../lib/workspaceChat.js";
import { IdentityPlans } from "./IdentityPlans.js";
import { SidebarSessionRow, type SidebarSessionRowProps, type WorkspaceClickModifiers } from "./SidebarSessionRow.js";

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
// buckets. `groupWorkspacesByDate` only ever emits today / yesterday / last-7 /
// older, so these keys can't collide with a date bucket.
const PINNED_GROUP_KEY = "pinned";
const ARCS_GROUP_KEY = "arcs";
const PRIORITY_GROUP_KEY = "priority";
const SIDE_CHATS_GROUP_KEY = "side-chats";
const ARCHIVED_GROUP_KEY = "archived";
const SNOOZED_GROUP_KEY = "snoozed";
const OLDER_GROUP_KEY = "older";
const STATUS_GROUPS = [
  { key: "status-working", label: "Working" },
  { key: "status-attention", label: "Needs attention" },
  { key: "status-completed", label: "Completed" },
  { key: "status-created", label: "Not started" }
] as const;

// Active and paused sort together, ahead of done; ties break by most recently
// touched. Only a non-active state gets a text marker on the row — active is
// the default and needs no badge to say so.
const ARC_STATE_SORT_RANK: Record<"active" | "paused" | "done", number> = {
  active: 0,
  paused: 0,
  done: 1
};
const ARC_STATE_LABEL: Record<"active" | "paused" | "done", string> = {
  active: "Active",
  paused: "Paused",
  done: "Done"
};

// Per-launch behavior: every session group except Pinned starts collapsed, so a
// fresh window opens on the standing pins and nothing else.
const BOOT_COLLAPSED_GROUP_KEYS: readonly string[] = [
  PRIORITY_GROUP_KEY,
  SIDE_CHATS_GROUP_KEY,
  "today",
  "yesterday",
  "last-7",
  OLDER_GROUP_KEY,
  ...STATUS_GROUPS.map((group) => group.key)
];

const VIEW_MODE_OPTIONS: ReadonlyArray<{ value: SidebarViewMode; label: string; description: string }> = [
  { value: "projects", label: "Projects", description: "Group chats under their project" },
  { value: "sessions", label: "Date", description: "Flat list of all chats by date" },
  { value: "status", label: "Status", description: "Group chats by working and completed status" }
];

const SORT_MODE_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string; description: string }> = [
  { value: "recent", label: "Recent Activity", description: "Most recently active project first" },
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

const IMPORTED_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode"
};

// Module scope, so these keep one identity across renders and the memoized
// rows below don't re-render because the sidebar did.
const openSettings = (): void => showSettings();
const openProviderSettings = (): void => showSettings("agents", "settings-providers");
const openDiagnosticsSettings = (): void => showSettings("advanced", "settings-diagnostics");
const openAboutSettings = (): void => showSettings("advanced", "settings-about");
const openCommandPalette = (): void => showCommandPalette("all");
const endSidebarPeek = (): void => setSidebarPeek(false);

export function Sidebar({
  loadState,
  onAddProject,
  onNewSideChat,
  onArchiveWorkspace,
  onOpenInIde,
  onOpenInWindow,
  onOpenLauncher,
  onOpenProject,
  onOpenWorkspaceChat,
  onOpenBrowser,
  onOpenClaudeArtifacts,
  onOpenArc,
  onRemoveProject,
  onRenameWorkspace,
  onForkWorkspace,
  onResizeMouseDown,
  onToggleWorkspacePinned,
  onRemoveFromPriority,
  onAddToPriority,
  onSnoozeWorkspace,
  onUnsnoozeWorkspace,
  onClearPriority,
  onSetWorkspaceIcon,
  onSyncNowWorkspace,
  showArcs = true,
  showArchived = true,
  showPriority,
  selectedProjectId,
  selectedWorkspaceId: currentWorkspaceId,
  browserSelected,
  scheduleSelected = false,
  hackingSelected = false,
  selectedArcId,
  snapshot,
  detectedIdes,
  defaultIde
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  /** Opens the launcher pre-set to side-chat mode. */
  onNewSideChat?: () => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenInIde: (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }) => void;
  /** Tears the chat off into a desktop window of its own. Absent in a window
   *  that is itself torn off, which hides the action. */
  onOpenInWindow?: (workspaceId: string) => void;
  onOpenLauncher: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenWorkspaceChat: (workspaceId: string, modifiers: WorkspaceClickModifiers) => void;
  onOpenBrowser?: () => void;
  onOpenClaudeArtifacts?: () => void;
  onOpenArc?: (arcId: string) => void;
  onRemoveProject?: (projectId: string) => void;
  onRenameWorkspace?: (workspaceId: string, taskLabel: string) => void;
  onForkWorkspace?: (workspaceId: string) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  onToggleWorkspacePinned?: (workspaceId: string, pinned: boolean) => void;
  /** Right-click "Mark Done" on a Priority row — drops it back to its normal group. */
  onRemoveFromPriority?: (workspaceId: string) => void;
  /** Right-click "Add to Priority" on any other row — floats it manually. */
  onAddToPriority?: (workspaceId: string) => void;
  /** Right-click "Snooze …" — moves the row to the Snoozed shelf until `until`. */
  onSnoozeWorkspace?: (workspaceId: string, until: string) => void;
  /** Right-click "Unsnooze" on a shelved row. */
  onUnsnoozeWorkspace?: (workspaceId: string) => void;
  /** "Clear" on the Priority header dismisses every row the section holds. */
  onClearPriority?: (workspaceIds: string[]) => void;
  /** Right-click "Edit Icon" on any row — both values null clears the glyph. */
  onSetWorkspaceIcon?: (
    workspaceId: string,
    icon: string | null,
    iconColor: string | null
  ) => void;
  /** Right-click "Sync Now" on an imported row — runs one session-sync sweep. */
  onSyncNowWorkspace?: () => void;
  showArcs?: boolean;
  showArchived?: boolean;
  /** Whether the Priority section renders at all (settings toggle). */
  showPriority: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  /** True while the workspace is the Browser page, so the rail item is current. */
  browserSelected?: boolean;
  /** Schedule is the page on screen, so its row is current and no chat is. */
  scheduleSelected?: boolean;
  /** Usage or Activity is on screen; both are the one Hacking row. */
  hackingSelected?: boolean;
  /** The arc page open in the workspace column, if any. */
  selectedArcId?: string | null;
  snapshot: DashboardSnapshot;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
}): JSX.Element {
  const { peeking } = useSidebarChrome();
  const grid = usePaneGrid();
  const { fullLauncherOpen } = useLauncherSurface();
  const [newArcDialogOpen, setNewArcDialogOpen] = useState(false);
  // The full-screen launcher hides the grid, so no row is painted as current
  // and none is marked as open. Esc restores both.
  const selectedWorkspaceId =
    fullLauncherOpen || browserSelected || scheduleSelected || hackingSelected || selectedArcId
      ? null
      : currentWorkspaceId;
  const openWorkspaceIds = useMemo(
    () =>
      fullLauncherOpen
        ? new Set<string>()
        : new Set(
            grid.rows.flatMap((row) =>
              row.flatMap((cell) => (cell.kind === "launcher" ? [] : [cell.workspaceId]))
            )
          ),
    [fullLauncherOpen, grid.rows]
  );
  const canDragWorkspaceToGrid = snapshot.sessions.length > 0;
  const warmLedgerPages = useCallback((): void => {
    if (loadState !== "ready" || typeof window === "undefined" || !window.argmax) return;
    warmLedgerPagesOnIntent(window.argmax);
  }, [loadState]);
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
  // double render doesn't double-write localStorage, and so every update to
  // the set — including the functional ones below — is persisted exactly once.
  useEffect(() => {
    if (!readBootSeeded(BOOT_COLLAPSE_SEED_KEY)) {
      if (snapshot.projects.length === 0) return;
      markBootSeeded(BOOT_COLLAPSE_SEED_KEY);
    }
    saveCollapsedProjectIds(collapsedProjectIds);
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
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [archivedArcsShown, setArchivedArcsShown] = useState(false);
  // The shelf starts collapsed on every launch: snoozing says "not now", and a
  // list that opens itself would say otherwise.
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  useEffect(() => {
    if (!readBootSeeded(BOOT_GROUP_COLLAPSE_SEED_KEY)) {
      markBootSeeded(BOOT_GROUP_COLLAPSE_SEED_KEY);
    }
    saveCollapsedDateGroupIds(collapsedDateGroups);
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
  const projectMenu = useAnchoredPopover({ open: projectMenuState !== null, placement: "bottom-end" });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const pointerDraggingWorkspaceId = useDraggingWorkspaceId();
  const priorityGroupRef = useRef<HTMLDivElement | null>(null);

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
  }, []);
  // Trigger lives in the row; popover is portaled. Both must count as "inside"
  // for the dismiss hook so a click in the popover doesn't immediately close it.
  useDismissOnOutsideOrEscape(
    projectMenu.anchorRef,
    projectMenuState !== null,
    closeProjectMenu,
    projectMenu.popoverRef
  );

  const orderedProjects = useMemo(
    // The hidden scratch project never renders as a project group: its
    // chats get the Chat group at the bottom of the projects view instead.
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

  // Sessions synced from a provider CLI's own history get a small provider
  // marker on the row, so a session that came from the terminal is never
  // mistaken for one this app started.
  const copyableIdsByWorkspace = useMemo(() => {
    const sessions = chatSessionByWorkspace(snapshot.sessions);
    return new Map(
      snapshot.workspaces.map((workspace) => [
        workspace.id,
        formatSessionIds(sessions.get(workspace.id) ?? null, workspace)
      ])
    );
  }, [snapshot.sessions, snapshot.workspaces]);

  // A chat started by another chat's agent (the `argmax` MCP launch tools)
  // names its parent on the row, so delegated work is not read as something
  // the user opened. Resolved through the parent session's own workspace
  // label; a parent that has left the snapshot leaves the row plain.
  const launchedByLabelByWorkspace = useMemo(() => {
    const labelByWorkspaceId = new Map(
      snapshot.workspaces.map((workspace) => [
        workspace.id,
        workspace.taskLabel.trim() || workspace.branch
      ])
    );
    const sessionById = new Map(snapshot.sessions.map((session) => [session.id, session]));
    const labels = new Map<string, string>();
    for (const session of snapshot.sessions) {
      if (!session.launchedBySessionId) continue;
      const parent = sessionById.get(session.launchedBySessionId);
      const label = parent ? labelByWorkspaceId.get(parent.workspaceId) : undefined;
      if (label) labels.set(session.workspaceId, label);
    }
    return labels;
  }, [snapshot.sessions, snapshot.workspaces]);

  const importedProviderByWorkspace = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of snapshot.sessions) {
      if (session.imported) {
        labels.set(session.workspaceId, IMPORTED_PROVIDER_LABELS[session.provider] ?? session.provider);
      }
    }
    return labels;
  }, [snapshot.sessions]);

  // Arcs sort active and paused ahead of done, most recently touched first
  // within each bucket, so a settled arc drops to the tail rather than
  // competing with the work still in flight.
  const arcs = useMemo(() => {
    const list = snapshot.arcs ?? [];
    return [...list].sort((a, b) => {
      const rankDiff = ARC_STATE_SORT_RANK[a.state] - ARC_STATE_SORT_RANK[b.state];
      return rankDiff !== 0 ? rankDiff : b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [snapshot.arcs]);
  // Archived arcs leave the list but stay one click away at its foot. The one
  // open in the workspace column keeps its row so the selection stays visible.
  const archivedArcCount = arcs.filter((arc) => arc.archivedAt).length;
  const listedArcs = arcs.filter(
    (arc) => !arc.archivedAt || archivedArcsShown || arc.id === selectedArcId
  );

  // A chat that belongs to an arc names it on the row, so a member reads as
  // part of a larger body of work rather than a chat someone opened cold.
  const arcLabelByWorkspace = useMemo(() => {
    const nameById = new Map((snapshot.arcs ?? []).map((arc) => [arc.id, arc.name]));
    const labels = new Map<string, string>();
    for (const session of snapshot.sessions) {
      if (!session.arcId) continue;
      const name = nameById.get(session.arcId);
      if (name) labels.set(session.workspaceId, name);
    }
    return labels;
  }, [snapshot.sessions, snapshot.arcs]);

  const { nested, detachedIds } = useSidebarChatNesting();
  const [detachedToReveal, setDetachedToReveal] = useState<string | null>(null);
  const detachChat = useCallback((workspaceId: string): void => {
    detachSidebarChat(workspaceId);
    setDetachedToReveal(workspaceId);
  }, []);
  const [collapsedChats, setCollapsedChats] = useState<Set<string>>(() => loadCollapsedChatIds());
  useEffect(() => {
    saveCollapsedChatIds(collapsedChats);
  }, [collapsedChats]);
  const workingWorkspaces = useMemo(
    () => workingWorkspaceIds(snapshot.sessions),
    [snapshot.sessions]
  );
  const allSidebarWorkspaces = useMemo(
    () =>
      snapshot.workspaces.filter(
        (workspace) => workspace.kind !== "popup" && workspaceIdsWithSessions.has(workspace.id)
      ),
    [workspaceIdsWithSessions, snapshot.workspaces]
  );
  const allSidebarWorkspacesRef = useRef(allSidebarWorkspaces);
  allSidebarWorkspacesRef.current = allSidebarWorkspaces;
  // Pruned on a click, not on every refresh: a partial dashboard load would
  // otherwise forget collapsed chats that are only briefly missing.
  const toggleChatChildren = useCallback((workspaceId: string): void => {
    setCollapsedChats((current) => {
      const listedIds = new Set(allSidebarWorkspacesRef.current.map((workspace) => workspace.id));
      const next = new Set([...current].filter((id) => listedIds.has(id)));
      if (current.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }, []);
  // A snooze lifts a row out of every section into the collapsed Snoozed shelf
  // until its time passes. Membership is derived from the clock, so there is no
  // poll: one timer is armed for the earliest expiry and re-derives the shelf.
  const [snoozeNow, setSnoozeNow] = useState(() => Date.now());
  const snoozeShelf = useMemo(
    () => computeSnoozeShelf(allSidebarWorkspaces, snapshot.sessions, snoozeNow),
    [allSidebarWorkspaces, snapshot.sessions, snoozeNow]
  );
  const nextSnoozeExpiryAt = snoozeShelf.nextExpiryAt;
  useEffect(() => {
    if (nextSnoozeExpiryAt === null) return;
    // A timer set before the Mac slept fires late. Re-derive when the window
    // comes back instead of waiting for it.
    const refresh = (): void => setSnoozeNow(Date.now());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timerId = window.setTimeout(
      () => setSnoozeNow(Date.now()),
      snoozeTimerDelay(nextSnoozeExpiryAt, Date.now())
    );
    return () => {
      window.clearTimeout(timerId);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [nextSnoozeExpiryAt, snoozeNow]);
  const unsnoozedWorkspaces = useMemo(
    () => allSidebarWorkspaces.filter((workspace) => !snoozeShelf.shelfIds.has(workspace.id)),
    [allSidebarWorkspaces, snoozeShelf]
  );
  const chatTree = useMemo(
    () => buildSidebarChatTree(
      unsnoozedWorkspaces.filter((workspace) => !isInArchivedSection(workspace)),
      snapshot.sessions, detachedIds, nested
    ),
    [unsnoozedWorkspaces, snapshot.sessions, detachedIds, nested]
  );
  const sidebarWorkspaces = useMemo(
    () => unsnoozedWorkspaces.filter((workspace) => !chatTree.parentByWorkspace.has(workspace.id)),
    [unsnoozedWorkspaces, chatTree]
  );
  const selectedRootId = selectedWorkspaceId
    ? chatTree.rootByWorkspace.get(selectedWorkspaceId) ?? selectedWorkspaceId
    : null;
  // Every listed chat, shelved or not: opening a snoozed chat must still mark
  // it viewed, and a shelved row must still show unread when it returns.
  const unreadWorkspaces = useUnreadWorkspaceIds(
    allSidebarWorkspaces,
    selectedWorkspaceId,
    workingWorkspaces
  );

  const eligiblePriorityIds = [...new Set([...unreadWorkspaces, ...workingWorkspaces])].sort().join("\n");
  const [prioritySelection, setPrioritySelection] = useState({
    selectedId: selectedWorkspaceId,
    eligibleIds: eligiblePriorityIds,
    retainedId: null as string | null
  });
  let retainedId = prioritySelection.retainedId;
  if (prioritySelection.selectedId !== selectedWorkspaceId || prioritySelection.eligibleIds !== eligiblePriorityIds) {
    retainedId = selectedWorkspaceId && (
      (prioritySelection.selectedId === selectedWorkspaceId && prioritySelection.retainedId === selectedWorkspaceId) ||
      prioritySelection.eligibleIds.split("\n").includes(selectedWorkspaceId)
    ) ? selectedWorkspaceId : null;
    setPrioritySelection({ selectedId: selectedWorkspaceId, eligibleIds: eligiblePriorityIds, retainedId });
  }
  const priorityUnreadIds = useMemo(() => {
    const ids = new Set(unreadWorkspaces);
    if (retainedId) ids.add(retainedId);
    return ids;
  }, [unreadWorkspaces, retainedId]);
  const rawPriorityEntries = useMemo(
    () => {
      const entries = showPriority || viewMode === "status"
        ? computePriorityEntries(
            unsnoozedWorkspaces,
            snapshot.sessions,
            priorityUnreadIds
          )
        : [];
      const manualOrder = workspaceOrders[PRIORITY_GROUP_KEY] ?? [];
      const positions = new Map(manualOrder.map((id, index) => [id, index]));
      // Unordered entries keep the selector's attention and activity order.
      return entries.sort((a, b) =>
        (positions.get(a.workspace.id) ?? manualOrder.length) -
        (positions.get(b.workspace.id) ?? manualOrder.length)
      );
    },
    [showPriority, viewMode, unsnoozedWorkspaces, snapshot.sessions, priorityUnreadIds, workspaceOrders]
  );
  const rawPriorityByWorkspace = useMemo(
    () => new Map(rawPriorityEntries.map((entry) => [entry.workspace.id, entry])),
    [rawPriorityEntries]
  );
  const priorityEntries = useMemo(() => {
    const byId = new Map(sidebarWorkspaces.map((workspace) => [workspace.id, workspace]));
    const seen = new Set<string>();
    const entries = rawPriorityEntries.flatMap((entry) => {
      if (viewMode === "status" && (!showPriority || !entry.workspace.priorityAddedAt)) return [];
      const rootId = chatTree.rootByWorkspace.get(entry.workspace.id) ?? entry.workspace.id;
      const workspace = byId.get(rootId);
      if (!workspace || workspace.pinned || seen.has(rootId)) return [];
      seen.add(rootId);
      const own = rawPriorityByWorkspace.get(rootId);
      return [{ ...entry, workspace, reason: own?.reason ?? null, attention: own?.attention ?? null }];
    });
    const manualOrder = workspaceOrders[PRIORITY_GROUP_KEY] ?? [];
    const positions = new Map(manualOrder.map((id, index) => [id, index]));
    return entries.sort((a, b) =>
      (positions.get(a.workspace.id) ?? manualOrder.length) -
      (positions.get(b.workspace.id) ?? manualOrder.length)
    );
  }, [sidebarWorkspaces, rawPriorityEntries, rawPriorityByWorkspace, chatTree, workspaceOrders, viewMode, showPriority]);
  const priorityOrderedIds = useMemo(
    () => priorityEntries.map((entry) => entry.workspace.id),
    [priorityEntries]
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
      showPriority || viewMode === "status" ? projectNameById.get(projectId) ?? null : null,
    [showPriority, viewMode, projectNameById]
  );

  const priorityWorkspaceIds = useMemo(
    () => new Set(priorityEntries.map((entry) => entry.workspace.id)),
    [priorityEntries]
  );
  const dismissablePriorityIds = useMemo(
    () =>
      rawPriorityEntries
        .filter((entry) => priorityWorkspaceIds.has(chatTree.rootByWorkspace.get(entry.workspace.id) ?? entry.workspace.id))
        .filter((entry) => !entry.working && !unreadWorkspaces.has(entry.workspace.id))
        .filter((entry) => entry.attention !== null || entry.workspace.priorityAddedAt)
        .map((entry) => entry.workspace.id),
    [rawPriorityEntries, priorityWorkspaceIds, chatTree, unreadWorkspaces]
  );
  // "Add to Priority" only makes sense while the section exists.
  const addToPriority = showPriority ? onAddToPriority : undefined;

  // Pinned workspaces float into a dedicated section at the very top of the
  // list, above Priority, the date buckets (sessions view), and the project
  // groups (projects view). They're pulled out of their normal bucket while
  // pinned and drop straight back the moment they're unpinned. Shared by both
  // view modes.
  // The user's drag order rides in `workspaceOrders` under the Pinned key, like
  // a project's order; chats newly pinned fall in below it by recency.
  const pinnedWorkspaces = useMemo(
    () =>
      sortWorkspaceGroup(
        sidebarWorkspaces.filter(
          (workspace) =>
            workspace.pinned &&
            !isInArchivedSection(workspace) &&
            workspaceIdsWithSessions.has(workspace.id)
        ),
        workspaceOrders[PINNED_GROUP_KEY] ?? []
      ),
    [sidebarWorkspaces, workspaceIdsWithSessions, workspaceOrders]
  );
  const pinnedWorkspaceIds = useMemo(
    () => pinnedWorkspaces.map((workspace) => workspace.id),
    [pinnedWorkspaces]
  );

  // Flat, date-bucketed list for the "sessions" view mode — every non-archived,
  // unpinned workspace that has a session, regardless of project, repo-less
  // chats included. Pinned ones live in the pinned section above instead, and
  // working or attention-worthy ones in Priority.
  const dateGroups = useMemo(
    () =>
      groupWorkspacesByDate(
        sidebarWorkspaces.filter(
          (workspace) =>
            !workspace.pinned &&
            !isInArchivedSection(workspace) &&
            !priorityWorkspaceIds.has(workspace.id) &&
            workspaceIdsWithSessions.has(workspace.id)
        )
      ),
    [sidebarWorkspaces, priorityWorkspaceIds, workspaceIdsWithSessions]
  );

  const statusGroups = useMemo(() => {
    const chats = chatSessionByWorkspace(snapshot.sessions);
    const statusByRoot = new Map<string, number>();
    for (const workspace of unsnoozedWorkspaces) {
      if (isInArchivedSection(workspace)) continue;
      const rootId = chatTree.rootByWorkspace.get(workspace.id) ?? workspace.id;
      const reasons = rawPriorityByWorkspace.get(workspace.id)?.reasons ?? [];
      const chat = chats.get(workspace.id);
      const stalled = chat && ["waiting", "blocked", "failed"].includes(chat.state) &&
        (!workspace.priorityDismissedAt || workspace.priorityDismissedAt < (chat.attentionChangedAt ?? chat.lastActivityAt));
      const status = workingWorkspaces.has(workspace.id) ? 0
        : stalled || reasons.some((reason) => reason.kind !== "pr-open") ? 1
        : chat?.state === "created" ? 3 : 2;
      statusByRoot.set(rootId, Math.min(statusByRoot.get(rootId) ?? status, status));
    }
    return STATUS_GROUPS.map((group, index) => ({
      ...group,
      items: sortWorkspaceGroup(sidebarWorkspaces.filter((workspace) =>
        !workspace.pinned && !isInArchivedSection(workspace) &&
        !priorityWorkspaceIds.has(workspace.id) && statusByRoot.get(workspace.id) === index
      ), [])
    })).filter((group) => group.items.length > 0);
  }, [snapshot.sessions, unsnoozedWorkspaces, chatTree, rawPriorityByWorkspace, workingWorkspaces, sidebarWorkspaces, priorityWorkspaceIds]);
  const listGroups = viewMode === "status" ? statusGroups : dateGroups;

  // The projects view has no project to file a repo-less chat under, so they
  // gather in a Chat group below the project groups. Pinned still wins — a row
  // lives in exactly one section.
  const sideChatWorkspaces = useMemo(
    () =>
      sidebarWorkspaces
        .filter(
          (workspace) =>
            workspace.kind === "scratch" &&
            !workspace.pinned &&
            !isInArchivedSection(workspace) &&
            !priorityWorkspaceIds.has(workspace.id) &&
            workspaceIdsWithSessions.has(workspace.id)
        )
        .sort((a, b) => {
          if (a.lastActivityAt === b.lastActivityAt) return 0;
          return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
        }),
    [sidebarWorkspaces, priorityWorkspaceIds, workspaceIdsWithSessions]
  );

  const snoozedWorkspaces = useMemo(
    () =>
      allSidebarWorkspaces
        .filter(
          (workspace) =>
            snoozeShelf.shelfIds.has(workspace.id) &&
            !isInArchivedSection(workspace) &&
            workspaceIdsWithSessions.has(workspace.id)
        )
        .sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "")),
    [allSidebarWorkspaces, snoozeShelf, workspaceIdsWithSessions]
  );

  const archivedWorkspaces = useMemo(
    () =>
      sidebarWorkspaces
        .filter(
          (workspace) =>
            isInArchivedSection(workspace) && workspaceIdsWithSessions.has(workspace.id)
        )
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [sidebarWorkspaces, workspaceIdsWithSessions]
  );

  // Functional updates throughout: several of these can run in one commit (two
  // forked workspaces landing in one delta), and a `new Set(state)` built from
  // the render closure would drop every write but the last. Persistence lives
  // in the effects above, keyed on the state, so no updater has a side effect.
  const toggleProjectVisibility = useCallback((projectId: string): void => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const expandProjectVisibility = useCallback((projectId: string): void => {
    setCollapsedProjectIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

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

  const toggleDateGroupVisibility = useCallback((key: string): void => {
    if (key === ARCHIVED_GROUP_KEY) {
      setArchivedExpanded((expanded) => !expanded);
      return;
    }
    if (key === SNOOZED_GROUP_KEY) {
      setSnoozedExpanded((expanded) => !expanded);
      return;
    }
    setCollapsedDateGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Expand whichever section hosts the given row: its recency bucket (or
  // Pinned / Priority) in the Sessions view, its project group (or Chat) in
  // the Projects view. The order mirrors the render order above — Priority
  // only takes git workspaces, so a running chat stays in its recency bucket
  // or the Chat group. Shared by the two reveal effects below.
  const revealWorkspaceGroup = useCallback(
    (selectedWorkspace: DashboardSnapshot["workspaces"][number], expandCollapsedAncestors: boolean): void => {
      if (expandCollapsedAncestors) {
        const ancestors: string[] = [];
        let parentId = chatTree.parentByWorkspace.get(selectedWorkspace.id);
        while (parentId) {
          ancestors.push(parentId);
          parentId = chatTree.parentByWorkspace.get(parentId);
        }
        setCollapsedChats((current) => {
          if (!ancestors.some((id) => current.has(id))) return current;
          return new Set([...current].filter((id) => !ancestors.includes(id)));
        });
      }
      const rootId = chatTree.rootByWorkspace.get(selectedWorkspace.id) ?? selectedWorkspace.id;
      const workspace = sidebarWorkspaces.find((candidate) => candidate.id === rootId) ?? selectedWorkspace;
      const groupKey = workspace.pinned
        ? PINNED_GROUP_KEY
        : priorityWorkspaceIds.has(workspace.id)
          ? PRIORITY_GROUP_KEY
          : viewMode === "projects" && workspace.kind === "scratch"
            ? SIDE_CHATS_GROUP_KEY
            : viewMode !== "projects"
              ? listGroups.find((group) => group.items.some((item) => item.id === workspace.id))
                  ?.key ?? null
              : null;
      // Older is a history dump, often dozens of rows. Auto-opening it to
      // confirm a launch (or because a stale session is selected in the grid)
      // buries the recency list the user is actually using. They can still
      // expand it by clicking the header.
      if (groupKey && groupKey !== OLDER_GROUP_KEY) {
        setCollapsedDateGroups((current) => {
          if (!current.has(groupKey)) return current;
          const next = new Set(current);
          next.delete(groupKey);
          return next;
        });
      }
      if (viewMode === "projects" && workspace.kind === "git") {
        expandProjectVisibility(workspace.projectId);
      }
    },
    [chatTree, sidebarWorkspaces, listGroups, expandProjectVisibility, priorityWorkspaceIds, viewMode]
  );

  useEffect(() => {
    if (!detachedToReveal || chatTree.parentByWorkspace.has(detachedToReveal)) return;
    const workspace = sidebarWorkspaces.find((candidate) => candidate.id === detachedToReveal);
    if (workspace) {
      revealWorkspaceGroup(workspace, true);
      setExpandedProjectIds((current) => new Set([...current, workspace.projectId]));
      const dateGroup = listGroups.find((group) => group.items.some((item) => item.id === workspace.id));
      if (dateGroup) {
        setExpandedDateGroups((current) => new Set([...current, dateGroup.key]));
        setCollapsedDateGroups((current) => new Set([...current].filter((key) => key !== dateGroup.key)));
      }
    }
    setDetachedToReveal(null);
  }, [detachedToReveal, chatTree, sidebarWorkspaces, revealWorkspaceGroup, listGroups]);

  // A newly launched (or newly selected) session must not vanish into a
  // collapsed section: expand the group that hosts the selected row. Older is
  // the exception (see revealWorkspaceGroup). A selection entering a new
  // grouping reveals its destination. Collapsing that same group stays closed.
  const lastExpandedForWorkspaceId = useRef<string | null>(null);
  // The shelf opens when the selection moves to a shelved chat, or the selected
  // chat enters the shelf. The effect depends on this flag, not on the shelf
  // object, which is derived again on every dashboard refresh: keyed on that, a
  // refresh would reopen a shelf the user closed over the selected row.
  const selectedChatIsShelved = selectedWorkspaceId !== null && snoozeShelf.shelfIds.has(selectedWorkspaceId);
  useEffect(() => {
    if (selectedChatIsShelved) setSnoozedExpanded(true);
  }, [selectedWorkspaceId, selectedChatIsShelved]);
  const selectedRootWorkspace = sidebarWorkspaces.find((workspace) => workspace.id === selectedRootId);
  const selectedGroupKey = selectedRootWorkspace?.pinned ? PINNED_GROUP_KEY
    : selectedRootId && priorityWorkspaceIds.has(selectedRootId) ? PRIORITY_GROUP_KEY
    : viewMode === "projects" ? selectedRootWorkspace?.projectId
    : listGroups.find((group) => group.items.some((workspace) => workspace.id === selectedRootId))?.key;
  const selectedRevealKey = `${selectedWorkspaceId}:${selectedRootId}:${viewMode}:${selectedGroupKey}`;
  useEffect(() => {
    if (!selectedWorkspaceId || lastExpandedForWorkspaceId.current === selectedRevealKey) return;
    const workspace = unsnoozedWorkspaces.find((candidate) => candidate.id === selectedWorkspaceId);
    if (!workspace || isInArchivedSection(workspace)) return;
    lastExpandedForWorkspaceId.current = selectedRevealKey;
    revealWorkspaceGroup(workspace, true);
  }, [revealWorkspaceGroup, selectedWorkspaceId, selectedRevealKey, unsnoozedWorkspaces]);

  // A workspace that APPEARS without being selected — a fork, or a session an
  // agent launched from inside another session — must also surface, so the
  // user sees the action succeeded. Diff against ids seen so far; the first
  // non-empty snapshot seeds silently so boot never unfolds everything.
  // The set only grows: replacing it with the current list forgot rows that
  // briefly dropped out (a partial dashboard load, a prune, a 200-row cap
  // shuffle) and treated their return as a brand-new launch.
  const knownWorkspaceIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const known = knownWorkspaceIdsRef.current;
    // Seeded from every listed chat, shelved ones included: a row that was
    // snoozed at launch and later leaves the shelf is not a new arrival, and
    // must not unfold a group the user collapsed.
    if (allSidebarWorkspaces.length === 0 && known === null) return;
    if (known === null) {
      knownWorkspaceIdsRef.current = new Set(allSidebarWorkspaces.map((workspace) => workspace.id));
      return;
    }
    const next = new Set(known);
    for (const workspace of allSidebarWorkspaces) {
      if (next.has(workspace.id)) continue;
      next.add(workspace.id);
      if (isInArchivedSection(workspace) || snoozeShelf.shelfIds.has(workspace.id)) continue;
      // A chat collapsed over its launched chats stays collapsed: the user
      // chose that, and the new chat surfaces once they open it.
      revealWorkspaceGroup(workspace, false);
    }
    knownWorkspaceIdsRef.current = next;
  }, [revealWorkspaceGroup, allSidebarWorkspaces, snoozeShelf]);

  // An arc opened from elsewhere (the palette, a chat's arc label) must not
  // sit selected inside a collapsed Arcs section.
  useEffect(() => {
    if (!selectedArcId) return;
    setCollapsedDateGroups((current) => {
      if (!current.has(ARCS_GROUP_KEY)) return current;
      const next = new Set(current);
      next.delete(ARCS_GROUP_KEY);
      return next;
    });
  }, [selectedArcId]);

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
    // A section of chats is named by its label ("Hide Pinned chats"); one
    // holding something else names the rows instead ("Hide arcs").
    (groupKey: string, label: string, isCollapsed: boolean, rowNoun?: string): JSX.Element => (
      <button
        aria-expanded={!isCollapsed}
        aria-label={`${isCollapsed ? "Show" : "Hide"} ${rowNoun ?? `${label} chats`}`}
        className="project-visibility"
        title={`${isCollapsed ? "Show" : "Hide"} ${rowNoun ?? "chats"}`}
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
    // Launched chats render inside their root's draggable wrapper. A drag that
    // starts on one of them would otherwise move the root.
    if (event.target instanceof Element && event.target.closest(".sidebar-chat-children")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(WORKSPACE_DRAG_MIME, workspaceId);
    event.dataTransfer.effectAllowed = "copyMove";
    setDraggingWorkspaceId(workspaceId);
    beginWorkspaceDrag(workspaceId);
  }, []);

  const handleWorkspaceDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (draggingWorkspaceId) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }, [draggingWorkspaceId]);

  const reorderWorkspace = useCallback(
    (
      sourceWorkspaceId: string,
      projectId: string,
      targetWorkspaceId: string,
      orderedIds: string[]
    ): void => {
      if (sourceWorkspaceId === targetWorkspaceId) return;
      const from = orderedIds.indexOf(sourceWorkspaceId);
      const to = orderedIds.indexOf(targetWorkspaceId);
      if (from === -1 || to === -1) {
        return;
      }
      const next = [...orderedIds];
      next.splice(from, 1);
      next.splice(to, 0, sourceWorkspaceId);
      const updated = { ...workspaceOrders, [projectId]: next };
      setWorkspaceOrders(updated);
      saveWorkspaceOrders(updated);
    },
    [workspaceOrders]
  );

  const handleWorkspaceDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, groupId: string, targetId: string, orderedIds: string[]): void => {
      event.preventDefault();
      event.stopPropagation();
      if (draggingWorkspaceId) reorderWorkspace(draggingWorkspaceId, groupId, targetId, orderedIds);
      setDraggingWorkspaceId(null);
    },
    [draggingWorkspaceId, reorderWorkspace]
  );

  useEffect(() => subscribeWorkspacePointerDrag({
    move: () => {},
    drop: ({ clientX, clientY }) => {
      const sourceId = workspaceDragSnapshot();
      if (!sourceId || !priorityOrderedIds.includes(sourceId)) return;
      const rows = priorityGroupRef.current?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? [];
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          reorderWorkspace(sourceId, PRIORITY_GROUP_KEY, row.dataset.workspaceId!, priorityOrderedIds);
          return;
        }
      }
    },
    cancel: () => {}
  }), [priorityOrderedIds, reorderWorkspace]);

  const handleWorkspaceDragEnd = useCallback((): void => {
    setDraggingWorkspaceId(null);
    endWorkspaceDrag();
  }, []);

  const descendantActivity = useMemo(() => {
    const summaries = new Map<string, { working: number; attention: number; unread: number }>();
    for (const workspace of unsnoozedWorkspaces) {
      let parentId = chatTree.parentByWorkspace.get(workspace.id);
      while (parentId) {
        const summary = summaries.get(parentId) ?? { working: 0, attention: 0, unread: 0 };
        if (workingWorkspaces.has(workspace.id)) summary.working += 1;
        if (rawPriorityByWorkspace.get(workspace.id)?.attention) summary.attention += 1;
        if (unreadWorkspaces.has(workspace.id)) summary.unread += 1;
        summaries.set(parentId, summary);
        parentId = chatTree.parentByWorkspace.get(parentId);
      }
    }
    return summaries;
  }, [unsnoozedWorkspaces, chatTree, workingWorkspaces, rawPriorityByWorkspace, unreadWorkspaces]);
  const renderChat = (
    workspace: DashboardSnapshot["workspaces"][number],
    overrides: Partial<SidebarSessionRowProps> = {}
  ): JSX.Element => {
    const children = chatTree.childrenByWorkspace.get(workspace.id) ?? [];
    const expanded = !collapsedChats.has(workspace.id);
    const isNested = chatTree.parentByWorkspace.has(workspace.id);
    const priority = rawPriorityByWorkspace.get(workspace.id);
    const activity = descendantActivity.get(workspace.id);
    const childActivity = activity?.attention ? `${activity.attention} need attention`
      : activity?.working ? `${activity.working} working`
      : activity?.unread ? `${activity.unread} unread` : undefined;
    return (
      <>
        <SidebarSessionRow
          workspace={workspace}
          isWorking={workingWorkspaces.has(workspace.id)}
          hasUnreadResponse={unreadWorkspaces.has(workspace.id)}
          copyableIds={copyableIdsByWorkspace.get(workspace.id)}
          importedProvider={importedProviderByWorkspace.get(workspace.id)}
          launchedByLabel={isNested ? undefined : launchedByLabelByWorkspace.get(workspace.id)}
          arcLabel={arcLabelByWorkspace.get(workspace.id)}
          isSelected={selectedWorkspaceId === workspace.id}
          isOpenInGrid={openWorkspaceIds.has(workspace.id)}
          canDragToGrid={canDragWorkspaceToGrid}
          onOpenWorkspaceChat={onOpenWorkspaceChat}
          onArchiveWorkspace={onArchiveWorkspace}
          onOpenInIde={onOpenInIde}
          onOpenInWindow={onOpenInWindow}
          onTogglePin={onToggleWorkspacePinned}
          onRename={onRenameWorkspace}
          onFork={onForkWorkspace}
          onSetIcon={onSetWorkspaceIcon}
          onSyncNow={onSyncNowWorkspace}
          onAddToPriority={!workspace.pinned && (viewMode === "status" ? !workspace.priorityAddedAt : !priority) ? addToPriority : undefined}
          onRemoveFromPriority={priority && (priority.attention !== null || workspace.priorityAddedAt) ? onRemoveFromPriority : undefined}
          priorityReason={priority?.reason ?? undefined}
          onSnooze={onSnoozeWorkspace}
          detectedIdes={detectedIdes}
          defaultIde={defaultIde}
          {...overrides}
          childrenExpanded={children.length ? expanded : undefined}
          childCount={children.length || undefined}
          childActivity={childActivity}
          onToggleChildren={children.length ? toggleChatChildren : undefined}
          onDetach={isNested ? detachChat : undefined}
        />
        {children.length > 0 && expanded ? (
          <div className="sidebar-chat-children" role="group" aria-label={`Chats launched from ${workspace.taskLabel || workspace.branch}`}>
            {children.map((child) => (
              <div key={child.id} className="sidebar-chat-child">
                {renderChat(child, { subtitle: child.projectId !== workspace.projectId ? projectNameById.get(child.projectId) : undefined })}
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  };

  // The version lives in the menu header; the chip speaks up only while local
  // data is not ready, so a failed load is never silent.
  const identitySubLabel = loadState === "loading"
    ? "Starting…"
    : loadState === "error"
      ? "Couldn't load local data"
      : null;
  const runIdentityAction = useCallback((action: () => void): void => {
    setIdentityMenuOpen(false);
    action();
  }, []);

  // The group labels already name the list, so there is no separate section
  // title. The "…" / "+" cluster rides the first list header instead: the
  // newest recency bucket in sessions view, the "Projects" header in projects
  // view. It falls back to a quiet label-less strip only when sessions view
  // has no bucket to host it.
  const leadListGroupKey = viewMode !== "projects" ? listGroups[0]?.key ?? null : null;
  const pinnedCollapsed = collapsedDateGroups.has(PINNED_GROUP_KEY);
  const priorityCollapsed = collapsedDateGroups.has(PRIORITY_GROUP_KEY);
  const archivedCollapsed = !archivedExpanded;
  const snoozedCollapsed = !snoozedExpanded;
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
            <li className="project-picker-group-label" role="presentation">
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
                    <PickerLead selected={isActive} />
                    {option.label}
                  </button>
                </li>
              );
            })}
            {viewMode === "projects" ? (
              <>
                <li className="project-picker-divider" role="separator" />
                <li className="project-picker-group-label" role="presentation">
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
                        <PickerLead selected={isActive} />
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
  // A first-class section above everything else: an arc spans projects, so it
  // doesn't belong nested under one. Like Pinned it opens expanded on launch,
  // and "New arc" stays on the header so it is one click even when collapsed.
  const arcsCollapsed = collapsedDateGroups.has(ARCS_GROUP_KEY);
  const arcsSection = (
    <div
      className="project-group session-date-group arcs-group"
      data-collapsed={arcsCollapsed ? "true" : undefined}
    >
      <div
        className="project-row session-date-row"
        onClick={() => toggleDateGroupVisibility(ARCS_GROUP_KEY)}
      >
        <span className="project-name session-date-label">
          <span className="project-name-text">Arcs</span>
          {renderCollapseButton(ARCS_GROUP_KEY, "Arcs", arcsCollapsed, "arcs")}
        </span>
        <span className="rail-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="small-icon"
            type="button"
            title="New arc"
            aria-label="New arc"
            onClick={() => setNewArcDialogOpen(true)}
          >
            <Plus size={14} />
          </button>
        </span>
      </div>
      {(arcsCollapsed ? [] : listedArcs).map((arc) => (
        <div key={arc.id} className="session-row-wrap">
          <button
            type="button"
            className="session-link arc-row"
            data-arc-state={arc.state}
            title={arc.name}
            aria-current={selectedArcId === arc.id ? "page" : undefined}
            onClick={() => onOpenArc?.(arc.id)}
          >
            <Workflow size={13} aria-hidden="true" />
            <span>{arc.name}</span>
            {arc.archivedAt ? (
              <span className="arc-row-state">Archived</span>
            ) : arc.state === "active" ? null : (
              <span className="arc-row-state">{ARC_STATE_LABEL[arc.state]}</span>
            )}
          </button>
        </div>
      ))}
      {!arcsCollapsed && archivedArcCount > 0 ? (
        <button
          type="button"
          className="sidebar-show-more"
          aria-expanded={archivedArcsShown}
          onClick={() => setArchivedArcsShown((shown) => !shown)}
        >
          {archivedArcsShown ? "Hide archived" : `Show ${archivedArcCount} archived`}
        </button>
      ) : null}
    </div>
  );
  const sideChatsCollapsed = collapsedDateGroups.has(SIDE_CHATS_GROUP_KEY);
  const sideChatsExpanded = expandedDateGroups.has(SIDE_CHATS_GROUP_KEY);
  const visibleSideChats = visibleSidebarItems(sideChatWorkspaces, selectedRootId, sideChatsExpanded);
  const hiddenSideChatCount = sideChatWorkspaces.length - visibleSideChats.length;
  // Projects view only, below the project groups. The sessions view files
  // chats into the recency buckets like any other row.
  const sideChatsSection =
    viewMode === "projects" && (onNewSideChat || sideChatWorkspaces.length > 0) ? (
      <div
        className="project-group session-date-group"
        data-collapsed={sideChatsCollapsed ? "true" : undefined}
      >
        <div
          className="project-row session-date-row"
          onClick={() => toggleDateGroupVisibility(SIDE_CHATS_GROUP_KEY)}
        >
          <span className="project-name session-date-label">
            <span className="project-name-text">Chat</span>
            {renderCollapseButton(SIDE_CHATS_GROUP_KEY, "Chat", sideChatsCollapsed, "chats")}
          </span>
          {onNewSideChat ? (
            <span className="rail-actions" onClick={(event) => event.stopPropagation()}>
              <button
                className="small-icon"
                type="button"
                title="New chat without a repository"
                aria-label="New chat without a repository"
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
                {renderChat(workspace)}
              </div>
            ))}
            {sideChatWorkspaces.length > SIDEBAR_SESSION_LIMIT ? (
              <button
                type="button"
                className="sidebar-show-more"
                aria-expanded={sideChatsExpanded}
                aria-label={
                  sideChatsExpanded
                    ? "Show fewer chats"
                    : `Show ${hiddenSideChatCount} more chats`
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
    <>
    <aside
      className="sidebar"
      data-loading={loadState === "loading" ? "true" : undefined}
      onMouseLeave={peeking ? endSidebarPeek : undefined}
    >
      <div className="window-controls" data-window-drag />
      <nav className="rail-nav" aria-label="Primary">
        <button
          className="rail-nav-item rail-nav-cta"
          type="button"
          title="New chat"
          aria-label="New chat"
          onClick={onOpenLauncher}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Plus size={14} />
          </span>
          <span className="rail-nav-label">New chat</span>
          <kbd aria-hidden="true">⌘N</kbd>
        </button>
        {/* With no arcs there is no Arcs header to carry its "+", so New arc
            sits beside New chat as the other way to start work. */}
        {showArcs && arcs.length === 0 ? (
          <button
            className="rail-nav-item"
            type="button"
            title="New arc"
            aria-label="New arc"
            onClick={() => setNewArcDialogOpen(true)}
          >
            <span className="rail-nav-glyph" aria-hidden="true">
              <Plus size={14} />
            </span>
            <span className="rail-nav-label">New arc</span>
          </button>
        ) : null}
        <button
          className="rail-nav-item"
          type="button"
          title="Schedule"
          aria-label="Schedule"
          aria-current={scheduleSelected ? "page" : undefined}
          onClick={showSchedulePage}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Clock size={14} />
          </span>
          <span className="rail-nav-label">Schedule</span>
        </button>
        <button
          className="rail-nav-item"
          type="button"
          title="Hacking"
          aria-label="Hacking"
          aria-current={hackingSelected ? "page" : undefined}
          onMouseEnter={warmLedgerPages}
          onClick={showUsagePage}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Activity size={14} />
          </span>
          <span className="rail-nav-label">Hacking</span>
        </button>
        {onOpenBrowser && typeof window !== "undefined" && window.argmax?.browser ? (
          <button
            className="rail-nav-item"
            type="button"
            title="Browser"
            aria-label="Browser"
            aria-current={browserSelected ? "page" : undefined}
            onClick={onOpenBrowser}
          >
            <span className="rail-nav-glyph" aria-hidden="true">
              <Globe size={14} />
            </span>
            <span className="rail-nav-label">Browser</span>
          </button>
        ) : null}
        {onOpenClaudeArtifacts && typeof window !== "undefined" && window.argmax?.browser ? (
          <button className="rail-nav-item" type="button" title="Claude artifacts" aria-label="Artifacts" onClick={onOpenClaudeArtifacts}>
            <span className="rail-nav-glyph" aria-hidden="true"><Shapes size={14} /></span>
            <span className="rail-nav-label">Artifacts</span>
          </button>
        ) : null}
        <button
          className="rail-nav-item"
          type="button"
          title="Customize"
          aria-label="Customize"
          onClick={openSettings}
        >
          <span className="rail-nav-glyph" aria-hidden="true">
            <Settings2 size={14} />
          </span>
          <span className="rail-nav-label">Customize</span>
          <kbd aria-hidden="true">⌘,</kbd>
        </button>
      </nav>

      <div className="project-list-scroll scroll-fade">
        <div className="project-list">
        {viewMode !== "projects" && leadListGroupKey === null ? (
          <div className="rail-heading">{sidebarActions}</div>
        ) : null}
        {/* Arcs sit above everything else: a body of work spanning several
            projects doesn't belong nested under any one of them. */}
        {showArcs && arcs.length > 0 ? arcsSection : null}
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
              <div
                key={workspace.id}
                className={`session-row-wrap${draggingWorkspaceId === workspace.id ? " dragging" : ""}`}
                draggable={Boolean(onToggleWorkspacePinned) && canDragWorkspaceToGrid}
                onDragStart={(event) => handleWorkspaceDragStart(event, workspace.id)}
                onDragOver={handleWorkspaceDragOver}
                onDrop={(event) =>
                  handleWorkspaceDrop(event, PINNED_GROUP_KEY, workspace.id, pinnedWorkspaceIds)
                }
                onDragEnd={handleWorkspaceDragEnd}
              >
                {renderChat(workspace, { subtitle: subtitleFor(workspace.projectId) })}
              </div>
            ))}
          </div>
        ) : null}
        {priorityEntries.length > 0 ? (
          <div
            ref={priorityGroupRef}
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
                  className="small-icon"
                  type="button"
                  title="Clear read chats from Priority"
                  aria-label="Clear read chats from Priority"
                  disabled={dismissablePriorityIds.length === 0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClearPriority(dismissablePriorityIds);
                  }}
                >
                  <Eraser size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {priorityCollapsed ? null : priorityEntries.map((entry) => (
              <div
                key={entry.workspace.id}
                className={`session-row-wrap${(draggingWorkspaceId ?? pointerDraggingWorkspaceId) === entry.workspace.id ? " dragging" : ""}`}
                draggable={canDragWorkspaceToGrid}
                onDragStart={(event) => handleWorkspaceDragStart(event, entry.workspace.id)}
                onDragOver={handleWorkspaceDragOver}
                onDrop={(event) =>
                  handleWorkspaceDrop(event, PRIORITY_GROUP_KEY, entry.workspace.id, priorityOrderedIds)
                }
                onDragEnd={handleWorkspaceDragEnd}
              >
                {renderChat(entry.workspace, { subtitle: subtitleFor(entry.workspace.projectId) })}
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
        {viewMode !== "projects"
          ? listGroups.map((group) => {
              const isCollapsed = collapsedDateGroups.has(group.key);
              const totalCount = group.items.length;
              const showAll = expandedDateGroups.has(group.key);
              const visibleItems = visibleSidebarItems(group.items, selectedRootId, showAll);
              const hiddenCount = totalCount - visibleItems.length;
              const hasOverflow = totalCount > SIDEBAR_SESSION_LIMIT;
              const isLead = group.key === leadListGroupKey;
              return (
                <div
                  className="project-group session-date-group"
                  data-collapsed={isCollapsed ? "true" : undefined}
                  key={group.key}
                  role={viewMode === "status" ? "group" : undefined}
                  aria-label={viewMode === "status" ? `${group.label} chats` : undefined}
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
                          {renderChat(workspace, { subtitle: subtitleFor(workspace.projectId) })}
                        </div>
                      ))}
                      {hasOverflow ? (
                        <button
                          type="button"
                          className="sidebar-show-more"
                          aria-expanded={showAll}
                          aria-label={
                            showAll
                              ? `Show fewer ${group.label} chats`
                              : `Show ${hiddenCount} more ${group.label} chats`
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
              const projectWorkspaces = sortWorkspaceGroup(
                sidebarWorkspaces.filter(
                  (workspace) =>
                    !workspace.pinned &&
                    workspace.projectId === project.id &&
                    !isInArchivedSection(workspace) &&
                    !priorityWorkspaceIds.has(workspace.id) &&
                    workspaceIdsWithSessions.has(workspace.id)
                ),
                manualOrder
              );
              const orderedWorkspaceIds = projectWorkspaces.map((workspace) => workspace.id);
              const isCollapsed = collapsedProjectIds.has(project.id);
              const totalCount = projectWorkspaces.length;
              const showAll = expandedProjectIds.has(project.id);
              const visibleWorkspaces = visibleSidebarItems(projectWorkspaces, selectedRootId, showAll);
              const hiddenCount = totalCount - visibleWorkspaces.length;
              const hasOverflow = totalCount > SIDEBAR_SESSION_LIMIT;
              const isDragging = draggingId === project.id;
              const isDragOver = dragOverId === project.id && !isDragging;
              // The repo the open chat is working in. A chat that moves to
              // another project carries this with it, so the sidebar always
              // names where the agent actually is. `isOpenProject` is the
              // narrower case — the project opened on its own, no chat.
              const hostsOpenChat = selectedProjectId === project.id;
              const isOpenProject = hostsOpenChat && !selectedWorkspaceId;
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
                  aria-current={hostsOpenChat ? "true" : undefined}
                  className={hostsOpenChat ? "project-name active" : "project-name"}
                  type="button"
                  onClick={(event) => {
                    // The project name opens the project; the row-level click
                    // (and the chevron) handle collapse, so stop this from
                    // bubbling up and immediately toggling visibility back.
                    event.stopPropagation();
                    if (isOpenProject) {
                      toggleProjectVisibility(project.id);
                      return;
                    }
                    expandProjectVisibility(project.id);
                    onOpenProject(project.id);
                  }}
                >
                  <span className="project-name-glyph" aria-hidden="true">
                    {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
                  </span>
                  <span className="project-name-text">{project.name}</span>
                </button>
                {onRemoveProject ? (
                  <div className="project-picker-anchor project-actions-anchor">
                    <button
                      ref={projectMenuState?.projectId === project.id ? projectMenu.setAnchor : null}
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
                        projectMenu.setAnchor(event.currentTarget);
                        setProjectMenuState({ projectId: project.id, mode: "menu" });
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                ) : null}
                <button
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Show" : "Hide"} ${project.name} chats`}
                  className="project-visibility"
                  title={`${isCollapsed ? "Show" : "Hide"} chats`}
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
                      {renderChat(workspace)}
                    </div>
                  ))}
                  {hasOverflow ? (
                    <button
                      type="button"
                      className="sidebar-show-more"
                      aria-expanded={showAll}
                      aria-label={
                        showAll
                          ? `Show fewer ${project.name} chats`
                          : `Show ${hiddenCount} more ${project.name} chats`
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
        {snoozedWorkspaces.length > 0 ? (
          <div
            className="project-group session-date-group snoozed-shelf"
            data-collapsed={snoozedCollapsed ? "true" : undefined}
          >
            <div
              className="project-row session-date-row"
              title={`${snoozedWorkspaces.length} snoozed ${snoozedWorkspaces.length === 1 ? "chat" : "chats"}`}
              onClick={() => toggleDateGroupVisibility(SNOOZED_GROUP_KEY)}
            >
              <span className="project-name session-date-label">
                <span className="project-name-text">Snoozed</span>
                {renderCollapseButton(SNOOZED_GROUP_KEY, "Snoozed", snoozedCollapsed)}
              </span>
              <span aria-hidden="true" />
            </div>
            {snoozedCollapsed ? null : snoozedWorkspaces.map((workspace) => (
              <div key={workspace.id} className="session-row-wrap">
                {renderChat(workspace, { subtitle: projectNameById.get(workspace.projectId), canDragToGrid: false, onTogglePin: undefined, onAddToPriority: undefined, onSnooze: undefined, onUnsnooze: onUnsnoozeWorkspace })}
              </div>
            ))}
          </div>
        ) : null}
        {showArchived && archivedWorkspaces.length > 0 ? (
          <div
            className="project-group session-date-group"
            data-collapsed={archivedCollapsed ? "true" : undefined}
          >
            <div
              className="project-row session-date-row"
              onClick={() => toggleDateGroupVisibility(ARCHIVED_GROUP_KEY)}
            >
              <span className="project-name session-date-label">
                <span className="project-name-text">Archived</span>
                {renderCollapseButton(ARCHIVED_GROUP_KEY, "Archived", archivedCollapsed)}
              </span>
              <span aria-hidden="true" />
            </div>
            {archivedCollapsed ? null : archivedWorkspaces.map((workspace) => (
              <div key={workspace.id} className="session-row-wrap">
                {renderChat(workspace, { subtitle: projectNameById.get(workspace.projectId), isWorking: false, hasUnreadResponse: false, canDragToGrid: false, onTogglePin: undefined, onAddToPriority: undefined, onSnooze: undefined })}
              </div>
            ))}
          </div>
        ) : null}
        </div>
      </div>

      {projectMenuState
        ? (() => {
            const activeProject = snapshot.projects.find((p) => p.id === projectMenuState.projectId);
            if (!activeProject || !onRemoveProject) return null;
            return createPortal(
              <ul
                ref={projectMenu.setPopover}
                className="project-picker-popover project-actions-popover"
                role="menu"
                aria-label={`${activeProject.name} actions`}
                style={projectMenu.floatingStyles}
              >
                {projectMenuState.mode === "menu" ? (
                  <>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        onClick={() => {
                          closeProjectMenu();
                          showSettings("projects", "settings-project-folders", activeProject.id);
                        }}
                      >
                        <Settings2 size={14} aria-hidden="true" />
                        Edit Project
                      </button>
                    </li>
                    <li className="project-picker-divider" role="separator" />
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
                        Remove Project
                      </button>
                    </li>
                  </>
                ) : (
                  <li role="none">
                    <p className="project-actions-confirm-text">
                      Forget <strong>{activeProject.name}</strong> and all its chats? Files on disk are untouched.
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
                <span className="identity-menu-subtitle">Local workspace · {APP_VERSION}</span>
              </li>
              <li className="project-picker-divider" role="separator" />
              <IdentityPlans onOpenUsage={() => runIdentityAction(showUsagePage)} />
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(openCommandPalette)}
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
                  onClick={() => runIdentityAction(showKeyboardCheatSheet)}
                >
                  <Keyboard size={14} aria-hidden="true" />
                  <span>Keyboard Shortcuts</span>
                  <kbd>⌘/</kbd>
                </button>
              </li>
              <li className="project-picker-divider" role="separator" />
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(openSettings)}
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
                  onClick={() => runIdentityAction(openProviderSettings)}
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
                  onClick={() => runIdentityAction(openDiagnosticsSettings)}
                >
                  <Activity size={14} aria-hidden="true" />
                  <span>Diagnostics & Logs</span>
                </button>
              </li>
              <li className="project-picker-divider" role="separator" />
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item identity-menu-item"
                  onClick={() => runIdentityAction(openAboutSettings)}
                >
                  <Info size={14} aria-hidden="true" />
                  <span>About Argmax</span>
                </button>
              </li>
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className="small-icon sidebar-footer-settings"
          aria-label="Open settings"
          title="Settings (⌘,)"
          onClick={openSettings}
        >
          <Settings size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="small-icon"
          aria-label="Open command palette"
          title="Command palette (⌘K)"
          onClick={openCommandPalette}
        >
          <Search size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-resizer" aria-hidden="true" onMouseDown={onResizeMouseDown} />
    </aside>
    <NewArcDialog open={newArcDialogOpen} onClose={() => setNewArcDialogOpen(false)} projects={orderedProjects} />
    </>
  );
}
