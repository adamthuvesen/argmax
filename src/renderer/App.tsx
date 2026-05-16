import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import type {
  AgentMode,
  ComposerAttachment,
  DashboardSnapshot,
  DetectedIde,
  IdeId,
  MenuCommand,
  ProjectSummary
} from "../shared/types.js";
import type { MessageHit as PaletteMessageHit, PaletteCommand } from "./components/CommandPalette.js";
// Heavy overlays are dynamic-imported on first open so the launcher's first
// paint doesn't construct the palette / search code paths (audit P4.03).
// The import functions are extracted so we can also warm them on idle after
// first paint — that way the cold ⌘K / ⌘F / Settings open hits a cached
// module instead of paying for transform+fetch+parse on the keypress.
const importCommandPalette = () => import("./components/CommandPalette.js");
const importSearchOverlay = () => import("./components/SearchOverlay.js");
const importSettingsPanel = () => import("./components/SettingsPanel.js");
// ReviewPanel pulls in CodeMirror + every @codemirror/lang-* package — ~680KB.
// LaunchSurface and SessionPane each lazy-import it locally; warming it from
// here means the first ⌘P Enter (which opens ReviewPanel in Files mode) hits a
// cached module rather than paying for the chunk fetch on the keypress. Vite
// dedupes by resolved URL so the lazy `import("./ReviewPanel.js")` sites and
// this prefetch share the same module instance.
const importReviewPanel = () => import("./components/ReviewPanel.js");
const importWorkspaceContentSearch = () => import("./components/WorkspaceContentSearchOverlay.js");
const CommandPalette = lazy(async () => ({
  default: (await importCommandPalette()).CommandPalette
}));
const WorkspaceContentSearchOverlay = lazy(async () => ({
  default: (await importWorkspaceContentSearch()).WorkspaceContentSearchOverlay
}));
import { parseFtsSnippet } from "./lib/paletteSearch.js";
import { EmptyState } from "./components/EmptyState.js";
import { KeyboardCheatSheet } from "./components/KeyboardCheatSheet.js";
import { LaunchSurface } from "./components/LaunchSurface.js";
const SearchOverlay = lazy(async () => ({
  default: (await importSearchOverlay()).SearchOverlay
}));
import { PerfOverlay } from "./components/PerfOverlay.js";
// SettingsPanel is lazy-mounted (ralph B1) — heavy diagnostics tiles, MCP
// dialog, and provider discovery shouldn't ship in the launcher's first paint.
const SettingsPanel = lazy(async () => ({
  default: (await importSettingsPanel()).SettingsPanel
}));
import { SessionMultiGrid } from "./components/SessionMultiGrid.js";
import { SkeletonPane } from "./components/SkeletonPane.js";
import { Sidebar } from "./components/Sidebar.js";
import type { WorkspaceClickModifiers } from "./components/SidebarSessionRow.js";
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
} from "./lib/gridState.js";
// demoSnapshot is dynamic-imported inside `loadDashboardSnapshot` so it stays
// out of the production renderer bundle. Browser-preview mode (no Electron
// bridge) is the only consumer; packaged builds always have window.argmax.
import { useDashboardSession } from "./hooks/useDashboardSession.js";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings.js";
import { useOverlays } from "./hooks/useOverlays.js";
import { useSidebarResize } from "./hooks/useSidebarResize.js";
import { isBrowserPreview } from "./lib/env.js";
import {
  applyFontToDocument,
  FONT_STORAGE_KEY,
  loadFontAssets,
  readStoredFont,
  type FontFamilyId
} from "./lib/fonts.js";
import { DEFAULT_IDE_KEY, readStoredDefaultIde } from "./lib/ide.js";
import { modelDefaultForProvider, type ModelPickerSelection } from "./lib/models.js";
import { buildSafeFtsPrefixQuery } from "./lib/ftsQuery.js";
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
  THINKING_STYLE_KEY,
  readStoredThinkingStyle,
  type ThinkingStyle
} from "./lib/thinkingStyle.js";
import { titleFromPrompt } from "./lib/projects.js";
import { markFirstContent, markFirstPaint } from "./lib/paintTimings.js";
import { mergeDashboardDelta } from "./lib/snapshot.js";

import { withToast, type ToastMessage } from "./lib/withToast.js";

const SIDEBAR_TOKENS_KEY = "argmax.sidebar.tokens.visible";

function readStoredSidebarTokensVisible(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SIDEBAR_TOKENS_KEY) === "true";
}

export function App(): JSX.Element {
  const [launchModel, setLaunchModel] = useState<ModelPickerSelection>(() => ({
    provider: "claude",
    ...modelDefaultForProvider("claude")
  }));
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    isPaletteOpen,
    setIsPaletteOpen,
    isCheatSheetOpen,
    setIsCheatSheetOpen,
    isSearchOpen,
    setIsSearchOpen,
    isContentSearchOpen,
    setIsContentSearchOpen
  } = useOverlays();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.argmax);
  const { sidebarWidth, isResizing, onResizeMouseDown } = useSidebarResize();
  // Tool-call expansion defaults to ON for every new session: a collapsed
  // preference is treated as an in-session override (the Settings toggle still
  // flips it for the current session) but doesn't carry across launches, so
  // each app start shows tool calls expanded.
  const [toolCallsExpanded, setToolCallsExpanded] = useState<boolean>(true);
  const [sidebarTokensVisible, setSidebarTokensVisible] = useState<boolean>(() => readStoredSidebarTokensVisible());
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(() => readStoredFont());
  const [detectedIdes, setDetectedIdes] = useState<DetectedIde[]>([]);
  const [defaultIde, setDefaultIde] = useState<IdeId | null>(() => readStoredDefaultIde());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readStoredPermissionMode());
  const [thinkingStyle, setThinkingStyle] = useState<ThinkingStyle>(() => readStoredThinkingStyle());
  const [newSessionMode, setNewSessionMode] = useState<NewSessionMode>(() => readStoredNewSessionMode());
  // `full` new-session mode hides the grid and renders LaunchSurface in its
  // place when ⌘N fires from inside an active grid. The flag is purely local
  // — it never persists; only the user's choice in Settings persists.
  const [isFullLauncherOpen, setIsFullLauncherOpen] = useState<boolean>(false);
  const [rightPanelToggleSignal, setRightPanelToggleSignal] = useState(0);
  const [grid, setGrid] = useState<GridState>(EMPTY_GRID);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  // The active surface (focused SessionPane, or the LaunchSurface when no
  // session is open) registers its file source + pick handler here so the
  // command palette can surface Files for that surface's scope.
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

  // Paint timing — first useLayoutEffect of <App /> marks "first-paint";
  // the loadState effect below marks "first-content" once the launcher /
  // session / settings surface is about to render for the first time.
  useLayoutEffect(() => {
    markFirstPaint();
  }, []);

  // Warm lazy overlay chunks after first paint so the first ⌘K / ⌘F /
  // Settings open isn't paying for transform+fetch+parse on the keypress.
  // Module cache dedupes with the Suspense-triggered import.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefetch = (): void => {
      void importCommandPalette();
      void importSearchOverlay();
      void importSettingsPanel();
      void importReviewPanel();
      void importWorkspaceContentSearch();
    };
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(prefetch, { timeout: 2000 });
      return () => {
        const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
        if (typeof cic === "function") cic(id);
      };
    }
    const id = window.setTimeout(prefetch, 800);
    return () => window.clearTimeout(id);
  }, []);

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
    openProjectLauncher,
    resolveApproval,
    pendingSelectionRef
  } = useDashboardSession(loadDashboardSnapshot, { onErrorToast: showErrorToast });

  // Lookups consumed by SessionMultiGrid so each cell can resolve its
  // session/workspace/project without scanning the snapshot per pane.
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
      if (!sessionForWorkspace) return;
      setSelectedProjectId(workspace.projectId);
      setGrid((current) =>
        openWorkspaceInGrid(
          current,
          { sessionId: sessionForWorkspace.id, workspaceId },
          modifiers
        )
      );
    },
    [snapshot.sessions, workspacesById, setSelectedProjectId]
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
      if (!sessionForWorkspace) return;
      setSelectedProjectId(workspace.projectId);
      setGrid((current) =>
        dropWorkspaceInGrid(
          current,
          { sessionId: sessionForWorkspace.id, workspaceId },
          target
        )
      );
    },
    [snapshot.sessions, workspacesById, setSelectedProjectId]
  );

  const handleWorkspaceDragStart = useCallback((workspaceId: string): void => {
    setDraggingWorkspaceId(workspaceId);
  }, []);

  const handleWorkspaceDragEnd = useCallback((): void => {
    setDraggingWorkspaceId(null);
  }, []);

  // Watchdog: some browsers/Electron versions skip `dragend` on the source
  // element when the user cancels with Esc at the OS level, leaving
  // draggingWorkspaceId stuck and every cell painting the drop overlay
  // forever. Subscribe to dragend at the document level (capture) while
  // a drag is active so we always clear on whatever fires the end. Drop cleanup
  // runs in bubble phase so React's target onDrop can still read the drag
  // identity from state before the watchdog clears it.
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

  const openNewSessionPane = useCallback((): void => {
    // `full` mode: when the grid already has panes, swap to the standalone
    // LaunchSurface instead of injecting a launcher cell. Grid is preserved;
    // the user returns to it after launching or pressing Esc.
    if (newSessionMode === "full" && grid.rows.length > 0) {
      setIsFullLauncherOpen(true);
      return;
    }
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
    grid.rows.length,
    newSessionMode,
    selectedProject?.id,
    selectedWorkspace?.projectId,
    snapshot.projects,
    workspacesById
  ]);

  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      switch (command) {
        case "open-settings":
          setIsPaletteOpen(false);
          setIsFullLauncherOpen(false);
          setIsSettingsOpen(true);
          return;
        case "new-session":
          setIsPaletteOpen(false);
          setIsSettingsOpen(false);
          openNewSessionPane();
          return;
        case "open-command-palette":
          setIsPaletteOpen(true);
          return;
        case "open-cheat-sheet":
          setIsCheatSheetOpen(true);
          return;
        case "toggle-sidebar":
          setRightPanelToggleSignal((signal) => signal + 1);
          return;
        case "toggle-debug-log":
        case "check-for-updates":
          // Wired in later phase tasks (P2.06 cheat sheet, P4 review
          // surface for debug-log lift, P7 updater). Menu accelerator
          // still fires when the native menu has focus.
          return;
      }
    },
    [openNewSessionPane, setIsCheatSheetOpen, setIsPaletteOpen, setIsSettingsOpen]
  );

  const openSearchOverlay = useCallback((): void => setIsSearchOpen(true), [setIsSearchOpen]);
  const openContentSearchOverlay = useCallback(
    (): void => setIsContentSearchOpen(true),
    [setIsContentSearchOpen]
  );
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
    onOpenSearch: openSearchOverlay,
    onOpenContentSearch: openContentSearchOverlay,
    onSelectSession: selectSessionFromKeybinding,
    onCloseSettings: closeSettingsFromKeybinding
  });

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_TOKENS_KEY, String(sidebarTokensVisible));
  }, [sidebarTokensVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FONT_STORAGE_KEY, fontFamily);
    applyFontToDocument(fontFamily);
    // Non-default font families dynamic-import their @fontsource CSS so the
    // cold-launch bundle doesn't ship every alternative (ralph B6).
    void loadFontAssets(fontFamily);
  }, [fontFamily]);

  // Fetch detected IDEs once. Main caches detection across the app lifetime,
  // so the second-mount cost is just one IPC round trip — but we still avoid
  // refetching while the renderer is alive.
  const ideListLoadedRef = useRef(false);
  useEffect(() => {
    if (ideListLoadedRef.current) return;
    if (!window.argmax) return;
    ideListLoadedRef.current = true;
    void window.argmax.system
      .listDetectedIdes()
      .then((list) => setDetectedIdes(list))
      .catch(() => {
        // Detection failure leaves detectedIdes empty; the button disables.
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (defaultIde === null) {
      window.localStorage.removeItem(DEFAULT_IDE_KEY);
    } else {
      window.localStorage.setItem(DEFAULT_IDE_KEY, defaultIde);
    }
  }, [defaultIde]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PERMISSION_MODE_KEY, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(THINKING_STYLE_KEY, thinkingStyle);
  }, [thinkingStyle]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(NEW_SESSION_MODE_KEY, newSessionMode);
  }, [newSessionMode]);

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
      setToast({ kind: "error", message: "Open the Electron app window to archive workspaces." });
      return;
    }
    let result: Awaited<ReturnType<typeof window.argmax.workspaces.archive>>;
    try {
      result = await window.argmax.workspaces.archive(workspaceId);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Workspace archive failed." });
      return;
    }
    setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result] }));
    // Backend refuses to remove a dirty worktree and falls back to "kept" —
    // the row stays in the sidebar (filter only hides "archived"). Tell the
    // user why, and don't clear selection since the workspace is still live.
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
  }, [selectedWorkspaceId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot]);

  const handleOpenInIde = useCallback(
    async (workspaceId: string, ide: IdeId, options?: { pinAsDefault?: boolean }): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Electron app window to launch an IDE." });
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
    [detectedIdes]
  );

  const addProject = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setToast({ kind: "error", message: "Open the Electron app window to add a project." });
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
  }, [setSelectedProjectId, setSnapshot]);

  const sendSessionInput = useCallback(
    async (
      sessionId: string,
      input: string,
      model: ProviderModelSelection,
      agentMode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to send input to a live session.");
      }

      await window.argmax.providers.sendInput({
        sessionId,
        input: `${input}\r`,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        agentMode,
        ...(attachments?.length ? { attachments } : {})
      });
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

  const toggleWorkspacePinned = useCallback(
    async (workspaceId: string, pinned: boolean): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Electron app window to pin a session." });
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

  const runCheck = useCallback(
    async (workspaceId: string, command: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Electron app window to run a check." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.checks.run({ workspaceId, command }),
        setToast,
        "Could not run check."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus]
  );

  const createCheckpoint = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Electron app window to save checkpoints." });
        return;
      }
      const label = `Checkpoint ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const ok = await withToast(
        () => window.argmax!.checkpoints.create({ workspaceId, label }),
        setToast,
        "Could not save checkpoint."
      );
      if (ok) {
        setToast({ kind: "info", message: `Saved ${label}.` });
        await refreshDashboardStatus();
      }
    },
    [refreshDashboardStatus]
  );

  const terminateSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to stop a live session.");
      }
      const ok = await withToast(
        () => window.argmax!.providers.terminate(sessionId),
        setToast,
        "Could not stop session."
      );
      if (ok) {
        await Promise.all([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
      }
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

  const launchTask = useCallback(
    async (
      prompt: string,
      model: ModelPickerSelection,
      agentMode: AgentMode,
      projectIdOverride?: string,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to launch local agents.");
      }

      const projectId = projectIdOverride ?? selectedProject?.id;
      if (!projectId) {
        throw new Error("Register a project before launching an agent.");
      }

      const workspace = await window.argmax.workspaces.createCurrent({
        projectId,
        taskLabel: titleFromPrompt(prompt)
      });

      const launchedSession = await window.argmax.providers.launch({
        workspaceId: workspace.id,
        provider: model.provider,
        prompt,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        agentMode,
        permissionMode,
        cols: 120,
        rows: 32,
        ...(attachments?.length ? { attachments } : {})
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      // If the user launched from the standalone full launcher, return them
      // to the grid view now that the new pane will be present and focused.
      setIsFullLauncherOpen(false);
      setGrid((current) =>
        openWorkspaceInGrid(
          current,
          { sessionId: launchedSession.id, workspaceId: workspace.id },
          { ctrlOrMeta: false, alt: false }
        )
      );
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(launchedSession.id)]);
    },
    [
      selectedProject?.id,
      refreshDashboardStatus,
      loadSessionEvents,
      pendingSelectionRef,
      permissionMode
    ]
  );

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const actions: PaletteCommand[] = [
      {
        id: "action:new-session",
        label: "New Session",
        subtitle: "Open the launcher",
        group: "Actions",
        run: () => handleMenuCommand("new-session")
      },
      {
        id: "action:open-settings",
        label: "Open Settings",
        subtitle: "Defaults, providers, tools",
        group: "Actions",
        run: () => setIsSettingsOpen(true)
      },
      {
        id: "action:search-sessions",
        label: "Search Sessions",
        subtitle: "Full-text search across every session timeline",
        group: "Actions",
        run: () => setIsSearchOpen(true)
      },
      ...(selectedSession && selectedSession.state === "running"
        ? [
            {
              id: "action:stop-session",
              label: "Stop Current Session",
              subtitle: selectedSession.modelLabel,
              group: "Actions" as const,
              run: () => void terminateSession(selectedSession.id)
            }
          ]
        : [])
    ];

    const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));

    const sessions: PaletteCommand[] = snapshot.sessions.slice(0, 40).map((session) => {
      const workspace = workspaceById.get(session.workspaceId) ?? null;
      const project = workspace ? projectById.get(workspace.projectId) ?? null : null;
      const label = workspace?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;
      const parts: string[] = [];
      if (project) parts.push(project.name);
      if (workspace?.branch) parts.push(workspace.branch);
      parts.push(session.modelLabel, session.state);
      return {
        id: `session:${session.id}`,
        label,
        subtitle: parts.filter(Boolean).join(" · "),
        group: "Sessions",
        run: () => {
          setIsSettingsOpen(false);
          openWorkspaceChat(session.workspaceId);
        }
      };
    });

    const projects: PaletteCommand[] = snapshot.projects.slice(0, 40).map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      subtitle: [project.currentBranch, project.repoPath].filter(Boolean).join(" · "),
      group: "Projects",
      run: () => {
        setIsSettingsOpen(false);
        setSelectedProjectId(project.id);
        setGrid(EMPTY_GRID);
      }
    }));

    return [...actions, ...sessions, ...projects];
  }, [
    snapshot.sessions,
    snapshot.workspaces,
    snapshot.projects,
    selectedSession,
    handleMenuCommand,
    terminateSession,
    openWorkspaceChat,
    setIsSearchOpen,
    setIsSettingsOpen,
    setSelectedProjectId
  ]);

  const sessionLabelById = useMemo(() => {
    const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const map = new Map<string, string>();
    for (const session of snapshot.sessions) {
      const workspace = workspaceById.get(session.workspaceId) ?? null;
      const project = workspace ? projectById.get(workspace.projectId) ?? null : null;
      const taskLabel = workspace?.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel;
      map.set(session.id, project ? `${project.name} · ${taskLabel}` : taskLabel);
    }
    return map;
  }, [snapshot.sessions, snapshot.workspaces, snapshot.projects]);

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
      const ftsQuery = buildSafeFtsPrefixQuery(trimmed);
      if (!ftsQuery) return [];
      const hits = await window.argmax.session.search({ query: ftsQuery, limit });
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

  const handleBranchSwitch = useCallback(
    (updated: ProjectSummary): void => {
      setSnapshot((s) => {
        // Skip reallocation when nothing actually changed (ralph E4) —
        // `git switch` to the same branch is a no-op.
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
    // grid renders launcher cells with explicit project arguments.
    (project: ProjectSummary | null): JSX.Element => (
      <LaunchSurface
        onAddProject={() => void addProject()}
        onBranchSwitch={handleBranchSwitch}
        onLaunchTask={(prompt, model, agentMode, attachments) => launchTask(prompt, model, agentMode, project?.id, attachments)}
        model={launchModel}
        onModelChange={setLaunchModel}
        onSelectProject={openProjectLauncher}
        project={project ?? selectedProject}
        projects={snapshot.projects}
        rightPanelToggleSignal={rightPanelToggleSignal}
        registerPaletteFileContext={registerPaletteFileContext}
      />
    ),
    [
      addProject,
      handleBranchSwitch,
      launchModel,
      launchTask,
      openProjectLauncher,
      registerPaletteFileContext,
      rightPanelToggleSignal,
      selectedProject,
      snapshot.projects
    ]
  );

  return (
    <main
      className="app-shell"
      tabIndex={-1}
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      data-resizing={isResizing ? "true" : undefined}
    >
      {bridgeMissing && !isBrowserPreview() ? (
        <div className="bridge-banner" role="alert">
          Preload bridge unavailable; running on demo data.
        </div>
      ) : null}
      {/*
        Lazy overlays — only mount when the user actually opens them. The
        first ⌘K / ⌘F press triggers the dynamic import; subsequent opens
        re-use the already-loaded chunk. Fallback is `null` because these
        are full-screen modals and a loading spinner would flash worse
        than a 1-frame delay on the cold-open path.
      */}
      {isPaletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette
            open={isPaletteOpen}
            commands={paletteCommands}
            onClose={() => setIsPaletteOpen(false)}
            searchMessages={searchMessages}
            fileSource={paletteFileContext?.source ?? null}
            loadFiles={loadPaletteFiles}
            onFilePick={paletteFileContext?.onPick}
          />
        </Suspense>
      ) : null}
      <KeyboardCheatSheet open={isCheatSheetOpen} onClose={() => setIsCheatSheetOpen(false)} />
      {isSearchOpen ? (
        <Suspense fallback={null}>
          <SearchOverlay
            open={isSearchOpen}
            onClose={() => setIsSearchOpen(false)}
            sessionLabelById={sessionLabelById}
            onSelectSession={(sessionId) => {
              const target = snapshot.sessions.find((session) => session.id === sessionId);
              setIsSettingsOpen(false);
              if (target) openWorkspaceChat(target.workspaceId);
            }}
          />
        </Suspense>
      ) : null}
      {isContentSearchOpen ? (
        <Suspense fallback={null}>
          <WorkspaceContentSearchOverlay
            open={isContentSearchOpen}
            onClose={() => setIsContentSearchOpen(false)}
            source={paletteFileContext?.source ?? null}
            onPick={paletteFileContext?.onPick ?? null}
          />
        </Suspense>
      ) : null}
      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <PerfOverlay />
      <Sidebar
        loadState={loadState}
        onToggleWorkspacePinned={(workspaceId, pinned) => void toggleWorkspacePinned(workspaceId, pinned)}
        onOpenLauncher={() => {
          setIsSettingsOpen(false);
          openNewSessionPane();
        }}
        onAddProject={() => void addProject()}
        onArchiveWorkspace={(id) => void handleArchiveWorkspace(id)}
        onOpenInIde={(workspaceId, ide, options) => void handleOpenInIde(workspaceId, ide, options)}
        onOpenProject={(projectId) => {
          setIsSettingsOpen(false);
          setIsFullLauncherOpen(false);
          setGrid(EMPTY_GRID);
          openProjectLauncher(projectId);
        }}
        onOpenSettings={() => {
          setIsFullLauncherOpen(false);
          setIsSettingsOpen(true);
        }}
        onOpenWorkspaceChat={(workspaceId, modifiers) => {
          setIsSettingsOpen(false);
          setIsFullLauncherOpen(false);
          openWorkspaceChat(workspaceId, modifiers);
        }}
        onWorkspaceDragStart={handleWorkspaceDragStart}
        onWorkspaceDragEnd={handleWorkspaceDragEnd}
        onResizeMouseDown={onResizeMouseDown}
        isSettingsActive={isSettingsOpen}
        selectedProjectId={selectedProject?.id ?? null}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        openWorkspaceIds={openWorkspaceIds}
        canDragWorkspaceToGrid={canDragWorkspaceToGrid}
        snapshot={snapshot}
        detectedIdes={detectedIdes}
        defaultIde={defaultIde}
        showSessionTokens={sidebarTokensVisible}
      />

      <section className="workspace">
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
                onDefaultModelChange={setLaunchModel}
                toolCallsExpanded={toolCallsExpanded}
                onToolCallsExpandedChange={setToolCallsExpanded}
                sidebarTokensVisible={sidebarTokensVisible}
                onSidebarTokensVisibleChange={setSidebarTokensVisible}
                fontFamily={fontFamily}
                onFontFamilyChange={setFontFamily}
                detectedIdes={detectedIdes}
                defaultIde={defaultIde}
                onDefaultIdeChange={setDefaultIde}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
                thinkingStyle={thinkingStyle}
                onThinkingStyleChange={setThinkingStyle}
                newSessionMode={newSessionMode}
                onNewSessionModeChange={setNewSessionMode}
                projects={snapshot.projects}
                onClose={() => setIsSettingsOpen(false)}
              />
            </Suspense>
          ) : isFullLauncherOpen ? (
            renderLaunchSurface(selectedProject)
          ) : grid.rows.length > 0 ? (
            <SessionMultiGrid
              grid={grid}
              approvals={snapshot.approvals}
              events={snapshot.events}
              rawOutputs={snapshot.rawOutputs}
              checks={snapshot.checks}
              projectsById={projectsById}
              workspacesById={workspacesById}
              sessionsById={sessionsById}
              defaultToolCallsExpanded={toolCallsExpanded}
              thinkingStyle={thinkingStyle}
              rightPanelToggleSignal={rightPanelToggleSignal}
              renderLauncher={renderLaunchSurface}
              dragSourceWorkspaceId={draggingWorkspaceId}
              onFocusPane={focusPane}
              onClosePane={closePane}
              onDropWorkspace={handleDropWorkspace}
              onLoadSessionEvents={loadSessionEvents}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              onTerminateSession={terminateSession}
              onCreateCheckpoint={createCheckpoint}
              onRunCheck={runCheck}
              registerPaletteFileContext={registerPaletteFileContext}
            />
          ) : (
            renderLaunchSurface(selectedProject)
          )}
        </div>
      </section>
    </main>
  );
}


async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!window.argmax) {
    // Vite tree-shakes the dynamic import out of the packaged renderer bundle
    // — only browser-preview loads pull in the demo fixture.
    const { demoSnapshot } = await import("./demoSnapshot.js");
    return demoSnapshot;
  }

  const [dashboard, approvals] = await Promise.all([
    window.argmax.dashboard.list(),
    window.argmax.approvals.pending()
  ]);
  return { ...dashboard, events: [], rawOutputs: [], approvals };
}
