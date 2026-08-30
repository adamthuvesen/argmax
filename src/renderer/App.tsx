import { PanelLeft } from "lucide-react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX
} from "react";
import type {
  AgentMode,
  ComposerAttachment,
  IdeId,
  MenuCommand,
  ProjectSummary,
  SessionSummary,
  WorkspaceContentSearchResult
} from "../shared/types.js";
import { SCRATCH_PROJECT_ID } from "../shared/types.js";
import { PROVIDER_TITLE_MODEL } from "../shared/providerModels.js";
import type {
  MessageHit as PaletteMessageHit,
  PaletteScope
} from "./components/CommandPalette.js";
import type { SettingsNavigationTarget } from "./components/SettingsPanel.js";
import type { SettingsGroupId } from "./components/settings/settingsMeta.js";
import { parseFtsSnippet } from "./lib/paletteSearch.js";
import { usePersistedSetting } from "./hooks/usePersistedSetting.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
import { EmptyState } from "./components/EmptyState.js";
import { KeyboardCheatSheet } from "./components/KeyboardCheatSheet.js";
import { LaunchSurface } from "./components/LaunchSurface.js";
import { PerfOverlay } from "./components/PerfOverlay.js";
import { DetailsPopup } from "./components/DetailsPopup.js";
import { MIN_RESIZABLE_CELL_WIDTH_PX, SessionMultiGrid } from "./components/SessionMultiGrid.js";
import { SkeletonPane } from "./components/SkeletonPane.js";
import { Sidebar } from "./components/Sidebar.js";
import { EMPTY_GRID, MAX_COLS, openWorkspaceInGrid, terminalWorkspaceId } from "./lib/gridState.js";
import { toggleTerminalPanel } from "./lib/terminalTabs.js";
import { onBrowserPanelRequest } from "./lib/browserPanel.js";
// demoSnapshot is dynamic-imported inside `loadDashboardSnapshot` so it stays
// out of the production renderer bundle. Browser-preview mode (no Tauri
// bridge) is the only consumer; packaged builds always have window.argmax.
import { useAppGridSelection } from "./hooks/useAppGridSelection.js";
import { useDashboardSession } from "./hooks/useDashboardSession.js";
import { useSessionCommands } from "./hooks/useSessionCommands.js";
import {
  CommandPalette,
  SettingsPanel,
  useLazyOverlayPrefetch
} from "./hooks/useLazyOverlayPrefetch.js";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings.js";
import { useOverlays } from "./hooks/useOverlays.js";
import { DEFAULT_WORKSPACE_MIN_WIDTH_PX, useSidebarResize } from "./hooks/useSidebarResize.js";
import { isBrowserPreview } from "./lib/env.js";
import { animateThemeChange } from "./lib/theme.js";
import { titleFromPrompt } from "./lib/projects.js";
import type { WorkspaceMode } from "./lib/workspaceMode.js";
import { persistLaunchModel, readStoredLaunchModel } from "./lib/launchModelPreference.js";
import { factoryLaunchModel, modelSupportsFastMode, type ModelPickerSelection } from "./lib/models.js";
import { listFilesFor } from "./lib/listFiles.js";
import {
  PERMISSION_MODE_KEY,
  readStoredPermissionMode,
  type PermissionMode
} from "./lib/permissionMode.js";
import {
  NEW_SESSION_MODE_KEY,
  readStoredNewSessionMode,
  type NewSessionMode
} from "./lib/newSessionMode.js";
import {
  CHAT_WIDTH_KEY,
  readStoredChatWidth,
  type ChatWidth
} from "./lib/chatWidth.js";
import {
  REVIEW_PANEL_SIDE_KEY,
  readStoredReviewPanelSide,
  type ReviewPanelSide
} from "./lib/reviewPanelSide.js";
import {
  CHAT_COST_KEY,
  COMPOSER_PIXEL_FIELD_KEY,
  FAST_MODE_KEY,
  RANDOM_SESSION_ICON_KEY,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_PRIORITY_KEY,
  THINKING_EXPANDED_KEY,
  TOOL_CALL_GROUPS_EXPANDED_KEY,
  TOOL_CALLS_EXPANDED_KEY,
  WORKSPACE_CARD_KEY,
  useBooleanUiPreference
} from "./lib/uiPreferences.js";
import { randomSessionIcon } from "./lib/sessionIcons.js";
import { loadDashboardSnapshot } from "./lib/loadDashboardSnapshot.js";
import { buildPaletteCommands, buildSessionLabelById } from "./lib/buildPaletteCommands.js";
import { useLauncherAppearance } from "./hooks/useLauncherAppearance.js";
import { usePriorityDemotion } from "./hooks/usePriorityDemotion.js";
import { markFirstContent, markFirstPaint } from "./lib/paintTimings.js";
import { mergeDashboardDelta } from "./lib/snapshot.js";
import { isTauriRuntime } from "./lib/tauriBridge.js";

import { withToast, type ToastMessage } from "./lib/withToast.js";

const APP_MIN_HEIGHT_PX = 640;
const STATIC_APP_MIN_WIDTH_PX = 1024;
// Full new-session view hides the grid. Reuse this empty set so the sidebar
// does not paint the still-focused pane as current. Esc restores the highlight.
const EMPTY_OPEN_WORKSPACE_IDS = new Set<string>();

function widestGridRowColumnCount(rows: unknown[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

export function App(): JSX.Element {
  const [launchModel, setLaunchModel] = useState<ModelPickerSelection>(
    () => readStoredLaunchModel() ?? factoryLaunchModel()
  );
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    isPaletteOpen,
    setIsPaletteOpen,
    isCheatSheetOpen,
    setIsCheatSheetOpen
  } = useOverlays();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [browserPanelUrl, setBrowserPanelUrl] = useState<string | null>(null);
  useEffect(() => onBrowserPanelRequest(setBrowserPanelUrl), []);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.argmax);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const settingsNavigationRequestRef = useRef(0);
  const [settingsNavigationTarget, setSettingsNavigationTarget] = useState<SettingsNavigationTarget | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [toolCallsExpanded, setToolCallsExpanded] = useBooleanUiPreference(TOOL_CALLS_EXPANDED_KEY, false);
  const [toolCallGroupsExpanded, setToolCallGroupsExpanded] = useBooleanUiPreference(
    TOOL_CALL_GROUPS_EXPANDED_KEY,
    false
  );
  const [sidebarPriorityVisible, setSidebarPriorityVisible] = useBooleanUiPreference(SIDEBAR_PRIORITY_KEY, true);
  const [sidebarCollapsed, setSidebarCollapsed] = useBooleanUiPreference(SIDEBAR_COLLAPSED_KEY, false);
  // Transient "peek" state: while collapsed, hovering the left edge slides the
  // sidebar out as an overlay; leaving it slides back. Not persisted.
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarPeek(false);
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);
  const [chatCostVisible, setChatCostVisible] = useBooleanUiPreference(CHAT_COST_KEY, false);
  const [workspaceCardVisible, setWorkspaceCardVisible] = useBooleanUiPreference(WORKSPACE_CARD_KEY, true);
  const [thinkingExpanded, setThinkingExpanded] = useBooleanUiPreference(THINKING_EXPANDED_KEY, false);
  const [fastModeEnabled, setFastModeEnabled] = useBooleanUiPreference(FAST_MODE_KEY, false);
  const [pixelFieldEnabled, setPixelFieldEnabled] = useBooleanUiPreference(COMPOSER_PIXEL_FIELD_KEY, false);
  const [randomSessionIconEnabled, setRandomSessionIconEnabled] = useBooleanUiPreference(
    RANDOM_SESSION_ICON_KEY,
    false
  );
  const handleLaunchModelChange = useCallback(
    (model: ModelPickerSelection): void => {
      setLaunchModel(model);
      persistLaunchModel(model);
    },
    []
  );
  const {
    themeMode,
    setThemeMode,
    accentId,
    setAccentId,
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    chatFontSize,
    setChatFontSize,
    defaultIde,
    setDefaultIde,
    detectedIdes
  } = useLauncherAppearance();
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readStoredPermissionMode());
  const [newSessionMode, setNewSessionMode] = useState<NewSessionMode>(() => readStoredNewSessionMode());
  const [chatWidth, setChatWidth] = useState<ChatWidth>(() => readStoredChatWidth());
  const [reviewPanelSide, setReviewPanelSide] = useState<ReviewPanelSide>(() => readStoredReviewPanelSide());
  // `full` new-session mode hides the grid and renders LaunchSurface in its
  // place when ⌘N fires from inside an active grid. The flag is purely local
  // — it never persists; only the user's choice in Settings persists.
  const [isFullLauncherOpen, setIsFullLauncherOpen] = useState<boolean>(false);
  const [launcherResetSignal, setLauncherResetSignal] = useState(0);
  // Launcher composes a repo-less side chat instead of a project session.
  // Toggled from the launcher's context picker; armed by the sidebar's
  // "New side chat", reset by every plain new-session entry point.
  const [launcherSideChatMode, setLauncherSideChatMode] = useState(false);
  const [isWorkspaceDropPreviewVisible, setIsWorkspaceDropPreviewVisible] = useState(false);
  const [rightPanelToggleSignal, setRightPanelToggleSignal] = useState(0);
  const [debugLogToggleSignal, setDebugLogToggleSignal] = useState(0);
  const [sessionGridRequiredWorkspaceMinWidth, setSessionGridRequiredWorkspaceMinWidth] = useState(0);
  // The active surface (focused SessionPane, or the LaunchSurface when no
  // session is open) registers its file source + pick handler here so the
  // command palette can surface Files for that surface's scope.
  // ⌘K and ⌘P open the same palette; only the pre-selected filter differs.
  const [paletteScope, setPaletteScope] = useState<PaletteScope>("all");
  const [paletteFileContext, setPaletteFileContext] = useState<{
    source: { kind: "workspace" | "project"; id: string };
    onPick: (path: string) => void;
  } | null>(null);
  const registerPaletteFileContext = useCallback(
    (context: { source: { kind: "workspace" | "project"; id: string }; onPick: (path: string) => void } | null) => {
      setPaletteFileContext(context);
    },
    []
  );

  const showErrorToast = useCallback((message: string): void => {
    setToast({ kind: "error", message });
  }, []);

  useLayoutEffect(() => {
    const node = workspaceRef.current;
    if (!node) return undefined;
    const updateWidth = (): void => {
      setWorkspaceWidth(node.getBoundingClientRect().width);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const maxGridColumnsPerRow = useMemo(() => {
    if (workspaceWidth <= 0) return MAX_COLS;
    return Math.max(1, Math.min(MAX_COLS, Math.floor(workspaceWidth / MIN_RESIZABLE_CELL_WIDTH_PX)));
  }, [workspaceWidth]);

  // Paint timing — first useLayoutEffect of <App /> marks "first-paint";
  // the loadState effect below marks "first-content" once the launcher /
  // session / settings surface is about to render for the first time.
  useLayoutEffect(() => {
    markFirstPaint();
  }, []);

  useLazyOverlayPrefetch();

  const {
    snapshot,
    setSnapshot,
    loadState,
    loadError,
    selectedWorkspaceId,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    setSelectedProjectId,
    selectedSession,
    selectedWorkspace,
    selectedProject,
    refresh: refreshDashboardStatus,
    loadDashboard,
    loadSessionEvents,
    loadAgentEvents,
    openProjectLauncher,
    resolveApproval,
    pendingSelectionRef
  } = useDashboardSession(loadDashboardSnapshot, { onErrorToast: showErrorToast });

  const {
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
    setLauncherPaneProject,
    openAgentPane,
    activateAgentTab,
    closeAgentTab
  } = useAppGridSelection({
    snapshot,
    selectedProject,
    selectedWorkspace,
    pendingSelectionRef,
    maxColumnsPerRow: maxGridColumnsPerRow,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    setSelectedProjectId,
    showErrorToast
  });

  const requiredGridColumns = useMemo(() => widestGridRowColumnCount(grid.rows), [grid.rows]);
  const requiredWorkspaceMinWidth = useMemo(() => {
    const gridColumnWidth = requiredGridColumns > 0
      ? requiredGridColumns * MIN_RESIZABLE_CELL_WIDTH_PX
      : DEFAULT_WORKSPACE_MIN_WIDTH_PX;
    return Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, gridColumnWidth, sessionGridRequiredWorkspaceMinWidth);
  }, [requiredGridColumns, sessionGridRequiredWorkspaceMinWidth]);
  const { sidebarWidth, isResizing, onResizeMouseDown } = useSidebarResize(requiredWorkspaceMinWidth);
  const requiredWindowMinWidth = useMemo(() => {
    const sidebarPart = sidebarCollapsed ? 0 : sidebarWidth;
    return Math.max(STATIC_APP_MIN_WIDTH_PX, requiredWorkspaceMinWidth + sidebarPart);
  }, [requiredWorkspaceMinWidth, sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (isBrowserPreview()) return undefined;
    if (!isTauriRuntime()) return undefined;

    let cancelled = false;
    void (async () => {
      const appWindow = getCurrentWindow();
      const minimumSize = new LogicalSize(requiredWindowMinWidth, APP_MIN_HEIGHT_PX);
      await appWindow.setMinSize(minimumSize);
      const scaleFactor = await appWindow.scaleFactor();
      const logicalSize = (await appWindow.innerSize()).toLogical(scaleFactor);
      if (cancelled || logicalSize.width >= requiredWindowMinWidth) return;
      await appWindow.setSize(
        new LogicalSize(requiredWindowMinWidth, Math.max(logicalSize.height, APP_MIN_HEIGHT_PX))
      );
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [requiredWindowMinWidth]);
  const showWorkspaceDropTarget = draggingWorkspaceId !== null && !isSettingsOpen && (grid.rows.length === 0 || isFullLauncherOpen);

  useEffect(() => {
    if (!showWorkspaceDropTarget) setIsWorkspaceDropPreviewVisible(false);
  }, [showWorkspaceDropTarget]);

  const scrollSettingsToTop = useCallback((): void => {
    const scroller = workspaceRef.current?.querySelector(".settings-scroll");
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = 0;
    }
  }, []);

  const openSettingsTarget = useCallback(
    (group: SettingsGroupId = "general", sectionId?: string): void => {
      setIsPaletteOpen(false);
      setIsFullLauncherOpen(false);
      settingsNavigationRequestRef.current += 1;
      setSettingsNavigationTarget({
        group,
        ...(sectionId ? { sectionId } : {}),
        requestId: settingsNavigationRequestRef.current
      });
      if (isSettingsOpen && group === "general" && !sectionId) {
        scrollSettingsToTop();
      }
      setIsSettingsOpen(true);
    },
    [
      isSettingsOpen,
      scrollSettingsToTop,
      setIsFullLauncherOpen,
      setIsPaletteOpen,
      setIsSettingsOpen
    ]
  );

  useLayoutEffect(() => {
    if (!isSettingsOpen) return;
    scrollSettingsToTop();
  }, [isSettingsOpen, scrollSettingsToTop]);

  useEffect(() => {
    // First non-loading render is the renderer's "first content" mark.
    // markFirstContent() is idempotent — flipping back to "loading" later
    // (a refresh, an error) won't reset the measure.
    if (loadState !== "loading") markFirstContent();
  }, [loadState]);

  useEffect(() => {
    if (!toast) return;
    // Errors stick until the user dismisses — losing them on a 4 s timer
    // means a blink can hide why a launch failed. Info toasts auto-dismiss.
    if (toast.kind === "error") return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const openLauncherSurface = useCallback(
    (sideChat: boolean): void => {
      setLauncherSideChatMode(sideChat);
      if (newSessionMode === "full" && grid.rows.length > 0) {
        setIsFullLauncherOpen(true);
        return;
      }
      openLauncherPaneInGrid();
    },
    [grid.rows.length, newSessionMode, openLauncherPaneInGrid]
  );
  const openNewSessionPane = useCallback((): void => openLauncherSurface(false), [openLauncherSurface]);
  // "New session here" from a pane menu skips openLauncherSurface, so it
  // resets chat mode itself before opening the in-grid launcher cell.
  const openNewSessionPaneInGrid = useCallback((): void => {
    setLauncherSideChatMode(false);
    openLauncherPaneInGrid();
  }, [openLauncherPaneInGrid]);

  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      switch (command) {
        case "open-settings":
          if (isSettingsOpen) {
            setIsSettingsOpen(false);
            return;
          }
          openSettingsTarget("general");
          return;
        case "new-session":
          setIsPaletteOpen(false);
          setIsSettingsOpen(false);
          openNewSessionPane();
          return;
        case "open-command-palette":
          setPaletteScope("all");
          setIsPaletteOpen(true);
          return;
        case "open-cheat-sheet":
          setIsCheatSheetOpen(true);
          return;
        case "toggle-sidebar":
          setRightPanelToggleSignal((signal) => signal + 1);
          return;
        case "toggle-debug-log":
          setDebugLogToggleSignal((signal) => signal + 1);
          return;
        case "check-for-updates":
          return;
      }
    },
    [isSettingsOpen, openNewSessionPane, openSettingsTarget, setIsCheatSheetOpen, setIsPaletteOpen, setIsSettingsOpen]
  );

  // ⌘P / ⌘F / ⌘⇧F are all the ⌘K overlay; only the pre-selected filter differs.
  const openFilePalette = useCallback((): void => {
    setPaletteScope("files");
    setIsPaletteOpen(true);
  }, [setIsPaletteOpen]);
  const openMessagePalette = useCallback((): void => {
    setPaletteScope("messages");
    setIsPaletteOpen(true);
  }, [setIsPaletteOpen]);
  const openContentPalette = useCallback((): void => {
    setPaletteScope("contents");
    setIsPaletteOpen(true);
  }, [setIsPaletteOpen]);
  const toggleIntegratedTerminal = useCallback((): void => {
    const workspaceId = terminalWorkspaceId(grid, [
      selectedWorkspace?.id,
      selectedSession?.workspaceId,
      snapshot.sessions[0]?.workspaceId
    ]);
    if (!workspaceId) {
      setToast({ kind: "error", message: "Open a session before toggling the terminal." });
      return;
    }

    setIsPaletteOpen(false);
    setIsCheatSheetOpen(false);
    setIsSettingsOpen(false);
    setIsFullLauncherOpen(false);
    openWorkspaceChat(workspaceId, { ctrlOrMeta: false, alt: false });
    // Toggle the workspace-keyed store directly. An earlier design bumped a
    // counter prop that SessionPane replayed in an effect — a remounted pane
    // (every session switch) re-saw the historical count and flipped the
    // persisted panel state on each visit.
    toggleTerminalPanel(workspaceId);
  }, [
    grid,
    openWorkspaceChat,
    selectedSession?.workspaceId,
    selectedWorkspace?.id,
    setIsCheatSheetOpen,
    setIsPaletteOpen,
    setIsSettingsOpen,
    snapshot.sessions
  ]);
  const selectSessionFromKeybinding = useCallback(
    (session: { id: string; workspaceId: string }): void => {
      // Cmd+1..9 always replaces the focused pane (no split modifier).
      setIsFullLauncherOpen(false);
      openWorkspaceChat(session.workspaceId, { ctrlOrMeta: false, alt: false });
    },
    [openWorkspaceChat]
  );
  const closeSettingsFromKeybinding = useCallback(
    (): void => setIsSettingsOpen(false),
    [setIsSettingsOpen]
  );
  useGlobalKeybindings({
    sessions: snapshot.sessions,
    onMenuCommand: handleMenuCommand,
    onCloseFocusedPane: closeFocusedPane,
    onOpenFilePalette: openFilePalette,
    onOpenSearch: openMessagePalette,
    onOpenContentSearch: openContentPalette,
    onToggleTerminal: toggleIntegratedTerminal,
    onSelectSession: selectSessionFromKeybinding,
    onCloseSettings: closeSettingsFromKeybinding
  });

  usePersistedSetting(PERMISSION_MODE_KEY, permissionMode);
  usePersistedSetting(NEW_SESSION_MODE_KEY, newSessionMode);
  usePersistedSetting(CHAT_WIDTH_KEY, String(chatWidth));
  usePersistedSetting(REVIEW_PANEL_SIDE_KEY, reviewPanelSide);

  // Esc closes the standalone full launcher (only meaningful when the grid
  // has active panes — when the grid is empty, the LaunchSurface is the only
  // surface and dismissing it would strand the user). Mirrors the typing-
  // target guard from useOverlays so Esc inside the prompt textarea doesn't
  // dismiss the surface itself.
  useEffect(() => {
    if (!isFullLauncherOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || target.isContentEditable) return;
      }
      setIsFullLauncherOpen(false);
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isFullLauncherOpen]);

  const handleArchiveWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (!window.argmax) {
      setToast({ kind: "error", message: "Open the Tauri app window to archive workspaces." });
      return;
    }
    // Shared workspaces leave the filesystem alone — only the sidebar row
    // goes away. Dirty isolated worktrees are destructive, so ask once and
    // pass force only after confirmation.
    const workspace = workspacesById.get(workspaceId);
    let force = false;
    if (workspace?.dirty && !workspace.sharedWorkspace) {
      const fileLabel = workspace.changedFiles === 1 ? "1 uncommitted change" : `${workspace.changedFiles} uncommitted changes`;
      const confirmed = window.confirm(
        `${workspace.taskLabel} has ${fileLabel}. Archiving will delete the worktree and discard these changes (the branch is preserved). Continue?`
      );
      if (!confirmed) return;
      force = true;
    }
    let result: Awaited<ReturnType<typeof window.argmax.workspaces.archive>>;
    try {
      result = await window.argmax.workspaces.archive({ workspaceId, force });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Workspace archive failed." });
      return;
    }
    // Without force a dirty worktree comes back as "kept" — the backend's
    // fresh status check found changes our cached snapshot missed, so the
    // confirm dialog above never showed. Re-prompt once with the real count
    // and retry with force; declining leaves the row kept, as intended.
    if (result.state === "kept" && !force && !result.sharedWorkspace) {
      const fileLabel = result.changedFiles === 1 ? "1 uncommitted change" : `${result.changedFiles} uncommitted changes`;
      const confirmed = window.confirm(
        `${result.taskLabel} has ${fileLabel}. Archiving will delete the worktree and discard these changes (the branch is preserved). Continue?`
      );
      if (!confirmed) {
        setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result] }));
        return;
      }
      try {
        result = await window.argmax.workspaces.archive({ workspaceId, force: true });
      } catch (error) {
        setToast({ kind: "error", message: error instanceof Error ? error.message : "Workspace archive failed." });
        return;
      }
    }
    setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result] }));
    if (result.state !== "archived") {
      setToast({
        kind: "info",
        message: "Workspace has uncommitted changes — kept in sidebar. Commit or discard, then retry archive."
      });
      return;
    }
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId(null);
      setSelectedSessionId(null);
    }
    // The grid-reconcile effect drops cells whose session/workspace vanished
    // from the snapshot — no manual prune here.
  }, [selectedWorkspaceId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot, workspacesById]);

  const handleOpenInIde = useCallback(
    async (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to launch an IDE." });
        return;
      }
      try {
        await window.argmax.workspaces.openInIde({ workspaceId, ide });
        if (options?.pinAsDefault) {
          setDefaultIde(ide);
        }
      } catch (error) {
        const ideLabel = detectedIdes.find((entry) => entry.id === ide)?.label ?? ide;
        setToast({
          kind: "error",
          message: error instanceof Error
            ? `Couldn't launch ${ideLabel}. ${error.message}`
            : `Couldn't launch ${ideLabel}.`
        });
      }
    },
    [detectedIdes, setDefaultIde]
  );

  const addProject = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setToast({ kind: "error", message: "Open the Tauri app window to add a project." });
      return;
    }

    try {
      const result = await window.argmax.projects.pickFolder();
      if (result.cancelled) {
        return;
      }

      setSelectedProjectId(result.project.id);
      setGrid(EMPTY_GRID);
      setSnapshot((current) => mergeDashboardDelta(current, { projects: [result.project] }));
      setToast({ kind: "info", message: `Added ${result.project.name}.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Argmax requires a local git repository."
      });
    }
  }, [setGrid, setSelectedProjectId, setSnapshot]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    if (!window.argmax) {
      setToast({ kind: "error", message: "Open the Tauri app window to remove a project." });
      return;
    }
    const projectName = snapshot.projects.find((p) => p.id === projectId)?.name ?? "project";
    try {
      await window.argmax.projects.remove({ projectId });
      // Drop the project + its workspaces + its sessions from the local snapshot
      // so the sidebar re-renders before the next full refresh lands.
      setSnapshot((current) => ({
        ...current,
        projects: current.projects.filter((p) => p.id !== projectId),
        workspaces: current.workspaces.filter((w) => w.projectId !== projectId),
        sessions: current.sessions.filter((s) =>
          current.workspaces.some((w) => w.id === s.workspaceId && w.projectId !== projectId)
        )
      }));
      if (selectedProject?.id === projectId) {
        setSelectedProjectId(null);
        setSelectedWorkspaceId(null);
        setSelectedSessionId(null);
        setGrid(EMPTY_GRID);
      }
      setToast({ kind: "info", message: `Removed ${projectName}.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : `Could not remove ${projectName}.`
      });
    }
  }, [
    snapshot.projects,
    selectedProject?.id,
    setSelectedProjectId,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    setGrid,
    setSnapshot
  ]);

  const toggleWorkspacePinned = useCallback(
    async (workspaceId: string, pinned: boolean): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to pin a session." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.workspaces.setPinned({ workspaceId, pinned }),
        setToast,
        "Could not toggle pin."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  const removeFromPriority = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to change priority." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.workspaces.setPriorityDismissed({ workspaceId, dismissed: true }),
        setToast,
        "Could not remove the session from priority."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  // Bulk "Clear" on the Priority header. Dismissing also clears a manual add
  // backend-side, so one call per row empties both flavors of entry. The rows
  // drop back into their date bucket or project group.
  const clearPriority = useCallback(
    async (workspaceIds: string[]): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to change priority." });
        return;
      }
      const ok = await withToast(
        () =>
          Promise.all(
            workspaceIds.map((workspaceId) =>
              window.argmax!.workspaces.setPriorityDismissed({ workspaceId, dismissed: true })
            )
          ),
        setToast,
        "Could not clear priority."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  const addToPriority = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to change priority." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.workspaces.setPriorityAdded({ workspaceId, added: true }),
        setToast,
        "Could not add the session to priority."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  usePriorityDemotion({
    selectedWorkspaceId,
    isSettingsOpen,
    isFullLauncherOpen,
    workspaces: snapshot.workspaces,
    sessions: snapshot.sessions,
    onDemote: (workspaceId) => {
      void removeFromPriority(workspaceId);
    }
  });

  // Random session icons for sessions this renderer did not launch: agent-
  // driven session control and the mobile companion create workspaces
  // backend-side, skipping the launch paths that call `setIcon`. When a
  // workspace first appears in a delta without an icon, decorate it here. The
  // renderer's own launches may race this effect and also assign one — both
  // writes pick a random icon, so last-write-wins is indistinguishable. The
  // first snapshot only seeds the known set: pre-existing sessions keep
  // whatever they have.
  const knownWorkspaceIdsForIcons = useRef<Set<string> | null>(null);
  useEffect(() => {
    // Seed only from a successfully loaded snapshot: the pre-load empty
    // snapshot and the error state's stale one would seed an empty set and
    // then decorate every historical row once the real snapshot lands.
    if (loadState !== "ready") return;
    const known = knownWorkspaceIdsForIcons.current;
    if (known === null) {
      knownWorkspaceIdsForIcons.current = new Set(snapshot.workspaces.map((workspace) => workspace.id));
      return;
    }
    for (const workspace of snapshot.workspaces) {
      if (known.has(workspace.id)) continue;
      known.add(workspace.id);
      if (!randomSessionIconEnabled || workspace.icon != null || workspace.kind === "popup") continue;
      void window.argmax?.workspaces
        .setIcon({ workspaceId: workspace.id, ...randomSessionIcon() })
        .catch(() => undefined);
    }
  }, [loadState, snapshot.workspaces, randomSessionIconEnabled]);

  const renameWorkspace = useCallback(
    async (workspaceId: string, taskLabel: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to rename a session." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.workspaces.setLabel({ workspaceId, taskLabel }),
        setToast,
        "Could not rename session."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  const setWorkspaceIcon = useCallback(
    async (workspaceId: string, icon: string | null, iconColor: string | null): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to change a session icon." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.workspaces.setIcon({ workspaceId, icon, iconColor }),
        setToast,
        "Could not change the session icon."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  // Stable per-row callbacks so SidebarSessionRow's memo comparator (which
  // checks reference equality on each prop) doesn't re-render every row on
  // every dashboard:delta. Inline lambdas would be recreated each render and
  // bust the memo.
  const onToggleWorkspacePinnedRow = useCallback(
    (workspaceId: string, pinned: boolean): void => {
      void toggleWorkspacePinned(workspaceId, pinned);
    },
    [toggleWorkspacePinned]
  );
  const onRenameWorkspaceRow = useCallback(
    (workspaceId: string, taskLabel: string): void => {
      void renameWorkspace(workspaceId, taskLabel);
    },
    [renameWorkspace]
  );
  const onRemoveFromPriorityRow = useCallback(
    (workspaceId: string): void => {
      void removeFromPriority(workspaceId);
    },
    [removeFromPriority]
  );
  const onAddToPriorityRow = useCallback(
    (workspaceId: string): void => {
      void addToPriority(workspaceId);
    },
    [addToPriority]
  );
  const onClearPrioritySection = useCallback(
    (workspaceIds: string[]): void => {
      void clearPriority(workspaceIds);
    },
    [clearPriority]
  );
  const onSetWorkspaceIconRow = useCallback(
    (workspaceId: string, icon: string | null, iconColor: string | null): void => {
      void setWorkspaceIcon(workspaceId, icon, iconColor);
    },
    [setWorkspaceIcon]
  );
  const onAddProjectRow = useCallback((): void => {
    void addProject();
  }, [addProject]);
  const onRemoveProjectRow = useCallback(
    (id: string): void => {
      void removeProject(id);
    },
    [removeProject]
  );
  const onArchiveWorkspaceRow = useCallback(
    (id: string): void => {
      void handleArchiveWorkspace(id);
    },
    [handleArchiveWorkspace]
  );
  const onOpenInIdeRow = useCallback(
    (workspaceId: string, ide: Parameters<typeof handleOpenInIde>[1], options: Parameters<typeof handleOpenInIde>[2]): void => {
      void handleOpenInIde(workspaceId, ide, options);
    },
    [handleOpenInIde]
  );
  // Session-pane "Open in <IDE>" menu action: same handler, no default pinning.
  const onOpenWorkspaceInIdePane = useCallback(
    (workspaceId: string, ide: IdeId): void => {
      void handleOpenInIde(workspaceId, ide);
    },
    [handleOpenInIde]
  );
  // Every explicit "open this repository" gesture exits side-chat mode, or
  // the launcher would ignore the repo the user just picked.
  const openRepoProjectLauncher = useCallback(
    (projectId: string): void => {
      setLauncherSideChatMode(false);
      openProjectLauncher(projectId);
    },
    [openProjectLauncher]
  );
  const onOpenProjectRow = useCallback(
    (projectId: string): void => {
      setIsSettingsOpen(false);
      setIsFullLauncherOpen(false);
      setGrid(EMPTY_GRID);
      openRepoProjectLauncher(projectId);
    },
    [openRepoProjectLauncher, setIsSettingsOpen, setIsFullLauncherOpen, setGrid]
  );
  const onOpenSettingsRow = useCallback((): void => {
    openSettingsTarget("general");
  }, [openSettingsTarget]);
  const onOpenProvidersRow = useCallback((): void => {
    openSettingsTarget("agents", "settings-providers");
  }, [openSettingsTarget]);
  const onOpenDiagnosticsRow = useCallback((): void => {
    openSettingsTarget("system", "settings-diagnostics");
  }, [openSettingsTarget]);
  const onOpenAboutRow = useCallback((): void => {
    openSettingsTarget("system", "settings-about");
  }, [openSettingsTarget]);
  const onOpenCommandPaletteRow = useCallback((): void => {
    setPaletteScope("all");
    setIsPaletteOpen(true);
  }, [setIsPaletteOpen]);
  const onOpenKeyboardShortcutsRow = useCallback((): void => {
    setIsCheatSheetOpen(true);
  }, [setIsCheatSheetOpen]);
  const onOpenWorkspaceChatRow = useCallback(
    (workspaceId: string, modifiers: Parameters<typeof openWorkspaceChat>[1]): void => {
      setIsSettingsOpen(false);
      setIsFullLauncherOpen(false);
      openWorkspaceChat(workspaceId, modifiers);
    },
    [openWorkspaceChat, setIsSettingsOpen, setIsFullLauncherOpen]
  );
  const onOpenLauncherRow = useCallback((): void => {
    setIsSettingsOpen(false);
    setLauncherResetSignal((signal) => signal + 1);
    openNewSessionPane();
  }, [openNewSessionPane, setIsSettingsOpen]);

  const { sendSessionInput, cancelQueuedMessage, sendQueuedMessageNow, runCheck, terminateSession } =
    useSessionCommands({ refreshDashboardStatus, loadSessionEvents, setToast, fastMode: fastModeEnabled });

  // The hidden "Side chats" project owns scratch workspaces; it is not a
  // repository, so every repo-picking surface (launcher, settings) sees only
  // the real projects, and a scratch selection never retargets the launcher.
  const realProjects = useMemo(
    () => snapshot.projects.filter((project) => project.id !== SCRATCH_PROJECT_ID),
    [snapshot.projects]
  );
  const launcherProject = useMemo(
    () =>
      selectedProject && selectedProject.id !== SCRATCH_PROJECT_ID
        ? selectedProject
        : realProjects[0] ?? null,
    [realProjects, selectedProject]
  );

  const launchTask = useCallback(
    async (
      prompt: string,
      model: ModelPickerSelection,
      agentMode: AgentMode,
      projectIdOverride: string | undefined,
      workspaceMode: WorkspaceMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to launch local agents.");
      }

      const projectId = projectIdOverride ?? selectedProject?.id;
      if (!projectId) {
        throw new Error("Register a project before launching an agent.");
      }

      const taskLabel = titleFromPrompt(prompt);
      // `worktree` forks an isolated git worktree off the live checked-out
      // branch; `current` runs in the project's existing checkout (shared
      // workspace). A grid cell can launch with an explicit project that
      // differs from `selectedProject`, so resolve the base branch by id.
      const launchingProject =
        snapshot.projects.find((p) => p.id === projectId) ?? selectedProject ?? null;
      // Worktree creation blocks on the project's setup command (installed
      // once per fresh worktree, before the agent starts). Say so, or a slow
      // `npm install` reads as a hung launch.
      if (workspaceMode === "worktree" && launchingProject?.settings.setupCommand.trim()) {
        setToast({
          kind: "info",
          message: `Running setup command in the new worktree: ${launchingProject.settings.setupCommand}`
        });
      }
      const api = window.argmax;
      let workspace =
        workspaceMode === "worktree"
          ? await api.workspaces.createIsolated({
              projectId,
              taskLabel,
              baseRef: launchingProject?.currentBranch ?? null
            })
          : await api.workspaces.createCurrent({ projectId, taskLabel });

      let launchedSession: SessionSummary;
      try {
        if (randomSessionIconEnabled) {
          workspace = await api.workspaces.setIcon({
            workspaceId: workspace.id,
            ...randomSessionIcon()
          });
        }
        launchedSession = await api.providers.launch({
          workspaceId: workspace.id,
          provider: model.provider,
          prompt,
          modelLabel: model.label,
          modelId: model.modelId,
          reasoningEffort: model.reasoningEffort ?? null,
          fastMode: fastModeEnabled && modelSupportsFastMode(model),
          agentMode,
          permissionMode,
          cols: 120,
          rows: 32,
          attachments: attachments?.length ? attachments : null
        });
      } catch (error) {
        // No session ever started, so the just-created workspace (and its
        // worktree) would sit stranded in the sidebar with no explanation.
        void api.workspaces
          .archive({ workspaceId: workspace.id, force: true })
          .catch(() => undefined);
        throw error;
      }

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      // Seed the snapshot immediately so the grid-reconcile effect doesn't
      // drop the just-opened pane while refresh/status is still in flight.
      setSnapshot((current) =>
        mergeDashboardDelta(current, {
          workspaces: [workspace],
          sessions: [launchedSession]
        })
      );
      // Full-launcher mode is a hard context switch: the old grid was hidden
      // while composing, so stale split panes (especially agent activity panes)
      // should not reappear beside the fresh session after launch.
      const launchedFromFullLauncher = isFullLauncherOpen;
      setIsFullLauncherOpen(false);
      setGrid((current) => {
        const cell = { sessionId: launchedSession.id, workspaceId: workspace.id };
        if (launchedFromFullLauncher) {
          return { rows: [[cell]], focused: { row: 0, col: 0 } };
        }
        return openWorkspaceInGrid(
          current,
          cell,
          { ctrlOrMeta: false, alt: false },
          { maxColumns: maxGridColumnsPerRow }
        );
      });
      void window.argmax.workspaces
        .autoTitle({
          workspaceId: workspace.id,
          provider: model.provider,
          modelId: PROVIDER_TITLE_MODEL[model.provider],
          prompt
        })
        .catch(() => undefined);
    },
    [
      selectedProject,
      isFullLauncherOpen,
      snapshot.projects,
      maxGridColumnsPerRow,
      pendingSelectionRef,
      permissionMode,
      fastModeEnabled,
      randomSessionIconEnabled,
      setGrid,
      setIsFullLauncherOpen,
      setSnapshot
    ]
  );

  // Repo-less side chat: a scratch workspace instead of a project checkout,
  // with no repository chrome. Launched from the chat-mode launcher (which
  // passes its own picks) or from the transcript selection toolbar (which
  // falls back to the launcher's current model and auto mode).
  const launchSideChat = useCallback(
    async (
      prompt: string,
      options?: {
        model?: ModelPickerSelection;
        agentMode?: AgentMode;
        attachments?: ComposerAttachment[];
      }
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to launch local agents.");
      }
      const api = window.argmax;
      const model = options?.model ?? launchModel;
      let workspace = await api.workspaces.createScratch({
        taskLabel: titleFromPrompt(prompt),
        kind: null
      });
      let launchedSession: SessionSummary;
      try {
        if (randomSessionIconEnabled) {
          workspace = await api.workspaces.setIcon({
            workspaceId: workspace.id,
            ...randomSessionIcon()
          });
        }
        launchedSession = await api.providers.launch({
          workspaceId: workspace.id,
          provider: model.provider,
          prompt,
          modelLabel: model.label,
          modelId: model.modelId,
          reasoningEffort: model.reasoningEffort ?? null,
          fastMode: fastModeEnabled && modelSupportsFastMode(model),
          agentMode: options?.agentMode ?? "auto",
          permissionMode,
          cols: 120,
          rows: 32,
          attachments: options?.attachments?.length ? options.attachments : null
        });
      } catch (error) {
        // No session ever started; don't strand the scratch workspace in the
        // Side chats section.
        void api.workspaces
          .archive({ workspaceId: workspace.id, force: true })
          .catch(() => undefined);
        throw error;
      }
      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      setSnapshot((current) =>
        mergeDashboardDelta(current, {
          workspaces: [workspace],
          sessions: [launchedSession]
        })
      );
      // Same hard context switch as launchTask: a full-launcher launch
      // replaces the hidden grid instead of splitting into it.
      const launchedFromFullLauncher = isFullLauncherOpen;
      setIsFullLauncherOpen(false);
      setGrid((current) => {
        const cell = { sessionId: launchedSession.id, workspaceId: workspace.id };
        if (launchedFromFullLauncher) {
          return { rows: [[cell]], focused: { row: 0, col: 0 } };
        }
        return openWorkspaceInGrid(
          current,
          cell,
          { ctrlOrMeta: false, alt: false },
          { maxColumns: maxGridColumnsPerRow }
        );
      });
      // The armed chat mode has served its purpose; the next plain new-session
      // entry should open in project mode again.
      setLauncherSideChatMode(false);
      void window.argmax.workspaces
        .autoTitle({
          workspaceId: workspace.id,
          provider: model.provider,
          modelId: PROVIDER_TITLE_MODEL[model.provider],
          prompt
        })
        .catch(() => undefined);
    },
    [
      fastModeEnabled,
      isFullLauncherOpen,
      launchModel,
      maxGridColumnsPerRow,
      pendingSelectionRef,
      permissionMode,
      randomSessionIconEnabled,
      setGrid,
      setIsFullLauncherOpen,
      setSnapshot
    ]
  );

  // Sidebar's "New side chat": the launcher surface pre-set to chat mode.
  const openSideChatLauncher = useCallback((): void => {
    setIsSettingsOpen(false);
    setLauncherResetSignal((signal) => signal + 1);
    openLauncherSurface(true);
  }, [openLauncherSurface, setIsSettingsOpen]);

  // "More details" explainer popup: one at a time, backed by an ephemeral
  // popup-kind scratch session that is terminated and archived when it goes
  // away. Popup rows never reach the sidebar (kind gating), and the boot
  // sweep below archives any strays a crash left behind.
  // `attachToChat` is the originating conversation's "add this excerpt as a
  // composer annotation" closure, surfaced as the popup's header button.
  const [detailsPopup, setDetailsPopup] = useState<{
    workspaceId: string;
    sessionId: string;
    attachToChat?: () => void;
  } | null>(null);
  // Ref mirror of the live popup: async launch/close paths read and dispose
  // through it so two in-flight launches can't both see stale state and leak
  // the loser's session (the state value a callback closed over may be old).
  const detailsPopupRef = useRef<{
    workspaceId: string;
    sessionId: string;
    attachToChat?: () => void;
  } | null>(null);
  const disposeDetailsSession = useCallback(
    (popup: { workspaceId: string; sessionId: string }): void => {
      const api = window.argmax;
      if (!api) return;
      // Direct provider terminate (not the toast-wrapped command): tearing
      // down an already-finished session is expected, not an error.
      void api.providers
        .terminate(popup.sessionId)
        .catch(() => undefined)
        .then(() => api.workspaces.archive({ workspaceId: popup.workspaceId, force: true }))
        .catch(() => undefined);
    },
    []
  );
  // Dispose outside the setState updater: updaters must stay pure (StrictMode
  // double-invokes them in dev, which would tear the session down twice).
  const closeDetailsPopup = useCallback((): void => {
    const current = detailsPopupRef.current;
    if (current) disposeDetailsSession(current);
    detailsPopupRef.current = null;
    setDetailsPopup(null);
  }, [disposeDetailsSession]);
  // A crash can strand popup workspaces (their lifecycle is close-to-discard,
  // never user-managed). Archive strays as snapshots arrive — an attempted-id
  // set (not a one-shot flag) keeps the sweep idempotent while still catching
  // rows that only show up after the first, possibly partial, delta. Ids of
  // popups launched this run are claimed into the set so the sweep can never
  // race a launch in flight.
  const sweptPopupWorkspaceIds = useRef(new Set<string>());
  const launchDetailsPopup = useCallback(
    async (prompt: string, context?: { attachToChat?: () => void }): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to launch local agents.");
      }
      const api = window.argmax;
      const workspace = await api.workspaces.createScratch({
        taskLabel: "More details",
        kind: "popup"
      });
      // create_scratch publishes the row before this command returns, so a
      // dashboard delta can land while providers.launch is still in flight.
      // Claim the id now or the stray sweep below would archive the popup —
      // and delete its scratch dir — out from under the launching session.
      sweptPopupWorkspaceIds.current.add(workspace.id);
      const launchedSession = await api.providers
        .launch({
          workspaceId: workspace.id,
          provider: launchModel.provider,
          prompt,
          modelLabel: launchModel.label,
          modelId: launchModel.modelId,
          reasoningEffort: launchModel.reasoningEffort ?? null,
          fastMode: fastModeEnabled && modelSupportsFastMode(launchModel),
          agentMode: "auto",
          // The popup renders no approval surface, so a gated session would
          // stall invisibly. It runs in an app-owned scratch dir; auto-approve
          // is safe there regardless of the app-wide permission setting.
          permissionMode: "auto-approve",
          cols: 120,
          rows: 32,
          attachments: null
        })
        .catch((error: unknown) => {
          // The claimed id is now exempt from the sweep for this app run, so
          // clean up the never-launched workspace here instead of stranding it.
          void api.workspaces
            .archive({ workspaceId: workspace.id, force: true })
            .catch(() => undefined);
          throw error;
        });
      const previous = detailsPopupRef.current;
      if (previous && previous.sessionId !== launchedSession.id) {
        disposeDetailsSession(previous);
      }
      detailsPopupRef.current = {
        workspaceId: workspace.id,
        sessionId: launchedSession.id,
        ...(context?.attachToChat ? { attachToChat: context.attachToChat } : {})
      };
      setSnapshot((current) =>
        mergeDashboardDelta(current, {
          workspaces: [workspace],
          sessions: [launchedSession]
        })
      );
      setDetailsPopup(detailsPopupRef.current);
    },
    [disposeDetailsSession, fastModeEnabled, launchModel, setSnapshot]
  );
  useEffect(() => {
    if (loadState === "loading" || !window.argmax) return;
    const api = window.argmax;
    for (const workspace of snapshot.workspaces) {
      if (
        workspace.kind === "popup" &&
        workspace.state !== "archived" &&
        workspace.id !== detailsPopupRef.current?.workspaceId &&
        !sweptPopupWorkspaceIds.current.has(workspace.id)
      ) {
        sweptPopupWorkspaceIds.current.add(workspace.id);
        void api.workspaces
          .archive({ workspaceId: workspace.id, force: true })
          .catch(() => undefined);
      }
    }
  }, [loadState, snapshot.workspaces]);

  const paletteCommands = useMemo(
    () =>
      buildPaletteCommands({
        snapshot,
        selectedSession,
        onNewSession: () => handleMenuCommand("new-session"),
        onOpenSettings: () => openSettingsTarget("general"),
        onOpenSettingsSection: (group, sectionId) => openSettingsTarget(group, sectionId),
        onOpenSearch: openMessagePalette,
        onStopSession: (sessionId) => void terminateSession(sessionId),
        onOpenWorkspace: openWorkspaceChat,
        onSelectProject: (projectId) => {
          setLauncherSideChatMode(false);
          setSelectedProjectId(projectId);
        },
        onClearGrid: () => setGrid(EMPTY_GRID),
        onCloseOverlays: () => setIsSettingsOpen(false)
      }),
    [
      snapshot,
      selectedSession,
      handleMenuCommand,
      openSettingsTarget,
      terminateSession,
      openWorkspaceChat,
      openMessagePalette,
      setIsSettingsOpen,
      setGrid,
      setSelectedProjectId
    ]
  );

  const sessionLabelById = useMemo(() => buildSessionLabelById(snapshot), [snapshot]);

  const loadPaletteFiles = useCallback(
    async (source: { kind: "workspace" | "project"; id: string }): Promise<string[]> => {
      const entries = await listFilesFor(source.kind, source.id);
      return entries.map((entry) => entry.path);
    },
    []
  );

  const searchMessages = useCallback(
    async (rawQuery: string, limit: number): Promise<PaletteMessageHit[]> => {
      if (!window.argmax) return [];
      const trimmed = rawQuery.trim();
      if (!trimmed) return [];
      const hits = await window.argmax.session.search({ query: trimmed, limit });
      return hits.map((hit) => ({
        id: `${hit.sessionId}:${hit.eventId}`,
        sessionId: hit.sessionId,
        label: sessionLabelById.get(hit.sessionId) ?? "Unknown session",
        snippetSegments: parseFtsSnippet(hit.snippet),
        run: () => {
          const target = snapshot.sessions.find((session) => session.id === hit.sessionId);
          setIsSettingsOpen(false);
          if (target) openWorkspaceChat(target.workspaceId);
        }
      }));
    },
    [sessionLabelById, snapshot.sessions, setIsSettingsOpen, openWorkspaceChat]
  );

  // `git grep` over the active surface's checkout, backing the palette's
  // Contents tab (⌘⇧F). Without a registered file source there is nothing to
  // grep, so the palette shows its "open a project first" empty state.
  const searchWorkspaceContents = useCallback(
    async (rawQuery: string): Promise<WorkspaceContentSearchResult> => {
      const source = paletteFileContext?.source;
      if (!source || !window.argmax) return { files: [], truncated: false };
      return window.argmax.workspace.grepContent({
        kind: source.kind,
        id: source.id,
        query: rawQuery
      });
    },
    [paletteFileContext?.source]
  );

  // Merge a fresh ProjectSummary (branch switch, settings save) into the
  // snapshot without disturbing anything else.
  const handleProjectUpdated = useCallback(
    (updated: ProjectSummary): void => {
      setSnapshot((s) => {
        // Skip reallocation when nothing actually changed; `git switch` to the
        // same branch is a no-op.
        const existing = s.projects.find((p) => p.id === updated.id);
        if (existing === updated) return s;
        let mutated = false;
        const projects = s.projects.map((p) => {
          if (p.id !== updated.id) return p;
          if (p === updated) return p;
          mutated = true;
          return updated;
        });
        return mutated ? { ...s, projects } : s;
      });
    },
    [setSnapshot]
  );

  const renderLaunchSurface = useCallback(
    // `project` is allowed to differ from `selectedProject` because the
    // grid renders launcher cells with explicit project arguments. A grid
    // launcher owns its project: switching repos there retargets that cell
    // instead of moving the app's selection off the sessions being watched.
    (project: ProjectSummary | null, options: { embedded?: boolean } = {}): JSX.Element => (
      <LaunchSurface
        fastModeEnabled={fastModeEnabled}
        pixelFieldEnabled={pixelFieldEnabled}
        onAddProject={() => void addProject()}
        onBranchSwitch={handleProjectUpdated}
        onFastModeEnabledChange={setFastModeEnabled}
        onLaunchTask={(prompt, model, agentMode, workspaceMode, attachments) => launchTask(prompt, model, agentMode, project?.id, workspaceMode, attachments)}
        onLaunchSideChat={(prompt, model, agentMode, attachments) =>
          launchSideChat(prompt, { model, agentMode, attachments })}
        model={launchModel}
        onModelChange={handleLaunchModelChange}
        onSelectProject={options.embedded ? setLauncherPaneProject : openRepoProjectLauncher}
        onSideChatModeChange={setLauncherSideChatMode}
        project={project ?? launcherProject}
        projects={realProjects}
        resetSignal={launcherResetSignal}
        rightPanelToggleSignal={rightPanelToggleSignal}
        registerPaletteFileContext={registerPaletteFileContext}
        sideChatMode={launcherSideChatMode}
      />
    ),
    [
      addProject,
      fastModeEnabled,
      handleProjectUpdated,
      handleLaunchModelChange,
      launcherResetSignal,
      launcherSideChatMode,
      launchModel,
      launchSideChat,
      launchTask,
      launcherProject,
      openRepoProjectLauncher,
      pixelFieldEnabled,
      realProjects,
      registerPaletteFileContext,
      rightPanelToggleSignal,
      setFastModeEnabled,
      setLauncherPaneProject
    ]
  );

  const renderEmbeddedLaunchSurface = useCallback(
    (project: ProjectSummary | null): JSX.Element => renderLaunchSurface(project, { embedded: true }),
    [renderLaunchSurface]
  );

  const detailsPopupWorkspace = detailsPopup
    ? workspacesById.get(detailsPopup.workspaceId) ?? null
    : null;
  const detailsPopupSession = detailsPopup ? sessionsById.get(detailsPopup.sessionId) ?? null : null;

  const handleWorkspaceSurfaceDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!showWorkspaceDropTarget) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setIsWorkspaceDropPreviewVisible(true);
  }, [showWorkspaceDropTarget]);

  const handleWorkspaceSurfaceDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setIsWorkspaceDropPreviewVisible(false);
  }, []);

  const handleWorkspaceSurfaceDrop = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!draggingWorkspaceId || !showWorkspaceDropTarget) return;
    event.preventDefault();
    setIsWorkspaceDropPreviewVisible(false);
    setIsFullLauncherOpen(false);
    handleDropWorkspace(draggingWorkspaceId, { row: 0, col: 0, position: "replace" });
  }, [draggingWorkspaceId, handleDropWorkspace, showWorkspaceDropTarget]);

  return (
    <main
      className="app-shell"
      tabIndex={-1}
      style={{
        gridTemplateColumns:
          (sidebarCollapsed ? "minmax(0, 1fr)" : `${sidebarWidth}px minmax(0, 1fr)`) +
          (browserPanelUrl !== null ? " minmax(360px, 480px)" : ""),
        ["--sidebar-width" as string]: `${sidebarWidth}px`
      }}
      data-resizing={isResizing ? "true" : undefined}
      data-chat-width={String(chatWidth)}
      data-review-panel-side={reviewPanelSide}
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
      data-sidebar-peek={sidebarCollapsed && sidebarPeek ? "true" : undefined}
    >
      <button
        type="button"
        className="sidebar-toggle"
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        onClick={toggleSidebarCollapsed}
      >
        <PanelLeft size={16} strokeWidth={1.75} />
      </button>
      {sidebarCollapsed ? (
        <div
          className="sidebar-peek-zone"
          aria-hidden="true"
          onMouseEnter={() => setSidebarPeek(true)}
        />
      ) : null}
      {bridgeMissing && !isBrowserPreview() ? (
        <div className="bridge-banner" role="alert">
          Tauri bridge unavailable; running on demo data.
        </div>
      ) : null}
      {/*
        Lazy overlays — only mount when the user actually opens them. The
        first ⌘K / ⌘P / ⌘F press triggers the dynamic import; subsequent opens
        re-use the already-loaded chunk. Fallback is `null` because these
        are full-screen modals and a loading spinner would flash worse
        than a 1-frame delay on the cold-open path.
      */}
      {isPaletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette
            open={isPaletteOpen}
            commands={paletteCommands}
            initialScope={paletteScope}
            onClose={() => setIsPaletteOpen(false)}
            searchMessages={searchMessages}
            fileSource={paletteFileContext?.source ?? null}
            loadFiles={loadPaletteFiles}
            onFilePick={paletteFileContext?.onPick}
            searchContents={searchWorkspaceContents}
          />
        </Suspense>
      ) : null}
      <KeyboardCheatSheet open={isCheatSheetOpen} onClose={() => setIsCheatSheetOpen(false)} />
      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <PerfOverlay />
      {detailsPopupWorkspace && detailsPopupSession ? (
        <DetailsPopup
          events={snapshot.events}
          onAttachToChat={detailsPopup?.attachToChat}
          onCancelQueuedMessage={cancelQueuedMessage}
          onClose={closeDetailsPopup}
          onLoadSessionEvents={loadSessionEvents}
          onSendQueuedMessageNow={sendQueuedMessageNow}
          onSendSessionInput={sendSessionInput}
          onTerminateSession={terminateSession}
          pendingMessages={snapshot.pendingMessages}
          project={null}
          rawOutputs={snapshot.rawOutputs}
          session={detailsPopupSession}
          workspace={detailsPopupWorkspace}
        />
      ) : null}
      <Sidebar
        loadState={loadState}
        onToggleWorkspacePinned={onToggleWorkspacePinnedRow}
        onRenameWorkspace={onRenameWorkspaceRow}
        onRemoveFromPriority={onRemoveFromPriorityRow}
        onAddToPriority={onAddToPriorityRow}
        onClearPriority={onClearPrioritySection}
        onSetWorkspaceIcon={onSetWorkspaceIconRow}
        showPriority={sidebarPriorityVisible}
        onOpenLauncher={onOpenLauncherRow}
        onAddProject={onAddProjectRow}
        onNewSideChat={openSideChatLauncher}
        onRemoveProject={onRemoveProjectRow}
        onArchiveWorkspace={onArchiveWorkspaceRow}
        onOpenInIde={onOpenInIdeRow}
        onOpenProject={onOpenProjectRow}
        onOpenSettings={onOpenSettingsRow}
        onOpenProviders={onOpenProvidersRow}
        onOpenDiagnostics={onOpenDiagnosticsRow}
        onOpenAbout={onOpenAboutRow}
        onOpenCommandPalette={onOpenCommandPaletteRow}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcutsRow}
        onOpenWorkspaceChat={onOpenWorkspaceChatRow}
        onWorkspaceDragStart={handleWorkspaceDragStart}
        onWorkspaceDragEnd={handleWorkspaceDragEnd}
        onResizeMouseDown={onResizeMouseDown}
        selectedProjectId={selectedProject?.id ?? null}
        selectedWorkspaceId={isFullLauncherOpen ? null : (selectedWorkspace?.id ?? null)}
        openWorkspaceIds={isFullLauncherOpen ? EMPTY_OPEN_WORKSPACE_IDS : openWorkspaceIds}
        canDragWorkspaceToGrid={canDragWorkspaceToGrid}
        snapshot={snapshot}
        detectedIdes={detectedIdes}
        defaultIde={defaultIde}
        collapsed={sidebarCollapsed}
        onPeekLeave={() => setSidebarPeek(false)}
      />

      <section className="workspace" ref={workspaceRef}>
        <div className={
          isSettingsOpen
            ? "work-scroll settings-scroll"
            : isFullLauncherOpen || grid.rows.length === 0
              ? "work-scroll launcher-scroll"
              : "work-scroll session-scroll"
        }>
          {loadState === "error" ? (
            <EmptyState message={loadError} onRetry={() => void loadDashboard()} />
          ) : loadState === "loading" && grid.rows.length === 0 && !isSettingsOpen ? (
            <SkeletonPane />
          ) : isSettingsOpen ? (
            <Suspense fallback={<SkeletonPane />}>
              <SettingsPanel
                defaultModel={launchModel}
                onDefaultModelChange={handleLaunchModelChange}
                toolCallsExpanded={toolCallsExpanded}
                onToolCallsExpandedChange={setToolCallsExpanded}
                toolCallGroupsExpanded={toolCallGroupsExpanded}
                onToolCallGroupsExpandedChange={setToolCallGroupsExpanded}
                sidebarPriorityVisible={sidebarPriorityVisible}
                onSidebarPriorityVisibleChange={setSidebarPriorityVisible}
                chatCostVisible={chatCostVisible}
                onChatCostVisibleChange={setChatCostVisible}
                workspaceCardVisible={workspaceCardVisible}
                onWorkspaceCardVisibleChange={setWorkspaceCardVisible}
                pixelFieldEnabled={pixelFieldEnabled}
                onPixelFieldEnabledChange={setPixelFieldEnabled}
                chatWidth={chatWidth}
                onChatWidthChange={setChatWidth}
                reviewPanelSide={reviewPanelSide}
                onReviewPanelSideChange={setReviewPanelSide}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                fastModeEnabled={fastModeEnabled}
                onFastModeEnabledChange={setFastModeEnabled}
                fontFamily={fontFamily}
                onFontFamilyChange={setFontFamily}
                fontSize={fontSize}
                onFontSizeChange={setFontSize}
                chatFontSize={chatFontSize}
                onChatFontSizeChange={setChatFontSize}
                themeMode={themeMode}
                onThemeModeChange={(mode) => {
                  animateThemeChange();
                  setThemeMode(mode);
                }}
                accentId={accentId}
                onAccentChange={(id) => {
                  animateThemeChange();
                  setAccentId(id);
                }}
                detectedIdes={detectedIdes}
                defaultIde={defaultIde}
                onDefaultIdeChange={setDefaultIde}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
                newSessionMode={newSessionMode}
                onNewSessionModeChange={setNewSessionMode}
                randomSessionIconEnabled={randomSessionIconEnabled}
                onRandomSessionIconEnabledChange={setRandomSessionIconEnabled}
                projects={realProjects}
                onProjectUpdated={handleProjectUpdated}
                navigationTarget={settingsNavigationTarget}
              />
            </Suspense>
          ) : isFullLauncherOpen ? (
            renderLaunchSurface(launcherProject)
          ) : grid.rows.length > 0 ? (
            <SessionMultiGrid
              chatFontSize={chatFontSize}
              grid={grid}
              approvals={snapshot.approvals}
              events={snapshot.events}
              rawOutputs={snapshot.rawOutputs}
              checks={snapshot.checks}
              projectsById={projectsById}
              workspacesById={workspacesById}
              sessionsById={sessionsById}
              defaultToolCallsExpanded={toolCallsExpanded}
              defaultToolCallGroupsExpanded={toolCallGroupsExpanded}
              defaultThinkingExpanded={thinkingExpanded}
              fastModeEnabled={fastModeEnabled}
              showCostPanel={chatCostVisible}
              workspaceCardVisible={workspaceCardVisible}
              onWorkspaceCardVisibleChange={setWorkspaceCardVisible}
              rightPanelToggleSignal={rightPanelToggleSignal}
              debugLogToggleSignal={debugLogToggleSignal}
              maxColumnsPerRow={maxGridColumnsPerRow}
              renderLauncher={renderEmbeddedLaunchSurface}
              dragSourceWorkspaceId={draggingWorkspaceId}
              onFocusPane={focusPane}
              onClosePane={closePane}
              onDropWorkspace={handleDropWorkspace}
              onFastModeEnabledChange={setFastModeEnabled}
              onLoadSessionEvents={loadSessionEvents}
              onLoadAgentEvents={loadAgentEvents}
              onNewSession={openNewSessionPaneInGrid}
              onOpenSideChat={launchSideChat}
              onOpenDetails={launchDetailsPopup}
              defaultIde={defaultIde}
              detectedIdes={detectedIdes}
              onOpenWorkspaceInIde={onOpenWorkspaceInIdePane}
              onOpenAgentPane={openAgentPane}
              onActivateAgentTab={activateAgentTab}
              onCloseAgentTab={closeAgentTab}
              onWorkspaceMinWidthChange={setSessionGridRequiredWorkspaceMinWidth}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              onCancelQueuedMessage={cancelQueuedMessage}
              onSendQueuedMessageNow={sendQueuedMessageNow}
              pendingMessages={snapshot.pendingMessages}
              onTerminateSession={terminateSession}
              onRunCheck={runCheck}
              registerPaletteFileContext={registerPaletteFileContext}
            />
          ) : (
            renderLaunchSurface(launcherProject)
          )}
        </div>
        {showWorkspaceDropTarget ? (
          <div
            className="workspace-drop-overlay"
            aria-hidden="true"
            onDragOver={handleWorkspaceSurfaceDragOver}
            onDragLeave={handleWorkspaceSurfaceDragLeave}
            onDrop={handleWorkspaceSurfaceDrop}
          >
            {isWorkspaceDropPreviewVisible ? (
              <div className="workspace-drop-zone" data-hovered="true" />
            ) : null}
          </div>
        ) : null}
      </section>
      {browserPanelUrl !== null ? (
        <BrowserPanel url={browserPanelUrl} onClose={() => setBrowserPanelUrl(null)} />
      ) : null}
    </main>
  );
}
