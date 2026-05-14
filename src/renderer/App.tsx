import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import type {
  DashboardSnapshot,
  DetectedIde,
  IdeId,
  MenuCommand
} from "../shared/types.js";
import type { MessageHit as PaletteMessageHit, PaletteCommand } from "./components/CommandPalette.js";
// Heavy overlays are dynamic-imported on first open so the launcher's first
// paint doesn't construct the palette / search code paths (audit P4.03).
const CommandPalette = lazy(async () => ({
  default: (await import("./components/CommandPalette.js")).CommandPalette
}));
import { parseFtsSnippet } from "./lib/paletteSearch.js";
import { EmptyState } from "./components/EmptyState.js";
import { KeyboardCheatSheet } from "./components/KeyboardCheatSheet.js";
import { LaunchSurface } from "./components/LaunchSurface.js";
const SearchOverlay = lazy(async () => ({
  default: (await import("./components/SearchOverlay.js")).SearchOverlay
}));
import { PerfOverlay } from "./components/PerfOverlay.js";
// SettingsPanel is lazy-mounted (ralph B1) — heavy diagnostics tiles, MCP
// dialog, and provider discovery shouldn't ship in the launcher's first paint.
const SettingsPanel = lazy(async () => ({
  default: (await import("./components/SettingsPanel.js")).SettingsPanel
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
import {
  PERMISSION_MODE_KEY,
  readStoredPermissionMode,
  type PermissionMode
} from "./lib/permissionMode.js";
import {
  THINKING_STYLE_KEY,
  readStoredThinkingStyle,
  type ThinkingStyle
} from "./lib/thinkingStyle.js";
import { titleFromPrompt } from "./lib/projects.js";
import { markFirstContent, markFirstPaint } from "./lib/paintTimings.js";
import { mergeDashboardDelta } from "./lib/snapshot.js";

type ToastMessage = { kind: "error" | "info"; message: string };

const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";
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
    setIsSearchOpen
  } = useOverlays();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.argmax);
  const { sidebarWidth, isResizing, onResizeMouseDown } = useSidebarResize();
  const [toolCallsExpanded, setToolCallsExpanded] = useState<boolean>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(TOOL_CALLS_EXPANDED_KEY) : null;
    return raw === null ? true : raw === "true";
  });
  const [sidebarTokensVisible, setSidebarTokensVisible] = useState<boolean>(() => readStoredSidebarTokensVisible());
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(() => readStoredFont());
  const [detectedIdes, setDetectedIdes] = useState<DetectedIde[]>([]);
  const [defaultIde, setDefaultIde] = useState<IdeId | null>(() => readStoredDefaultIde());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readStoredPermissionMode());
  const [thinkingStyle, setThinkingStyle] = useState<ThinkingStyle>(() => readStoredThinkingStyle());
  const [rightPanelToggleSignal, setRightPanelToggleSignal] = useState(0);
  const [grid, setGrid] = useState<GridState>(EMPTY_GRID);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);

  const showErrorToast = useCallback((message: string): void => {
    setToast({ kind: "error", message });
  }, []);

  // Paint timing — first useLayoutEffect of <App /> marks "first-paint";
  // the loadState effect below marks "first-content" once the launcher /
  // session / settings surface is about to render for the first time.
  useLayoutEffect(() => {
    markFirstPaint();
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
    () => new Set(grid.rows.flatMap((row) => row.map((cell) => cell.workspaceId))),
    [grid.rows]
  );
  const canDragWorkspaceToGrid = grid.rows.length > 0;

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
          const next = row.filter((cell) => sessionsById.has(cell.sessionId) && workspacesById.has(cell.workspaceId));
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
  }, [sessionsById, workspacesById]);

  // Mirror grid.focused → hook selection state. Avoids racing on initial
  // mount by skipping when the focused cell already matches what the hook
  // last produced.
  useEffect(() => {
    const cell = focusedCell(grid);
    if (cell) {
      setSelectedSessionId(cell.sessionId);
      setSelectedWorkspaceId(cell.workspaceId);
      return;
    }
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [grid, setSelectedSessionId, setSelectedWorkspaceId]);

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

  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      switch (command) {
        case "open-settings":
          setIsPaletteOpen(false);
          setIsSettingsOpen(true);
          return;
        case "new-session":
          setIsPaletteOpen(false);
          setIsSettingsOpen(false);
          setGrid(EMPTY_GRID);
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
    [setIsCheatSheetOpen, setIsPaletteOpen, setIsSettingsOpen]
  );

  const openSearchOverlay = useCallback((): void => setIsSearchOpen(true), [setIsSearchOpen]);
  const selectSessionFromKeybinding = useCallback(
    (session: { id: string; workspaceId: string }): void => {
      // Cmd+1..9 always replaces the focused pane (no split modifier).
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
    onSelectSession: selectSessionFromKeybinding,
    onCloseSettings: closeSettingsFromKeybinding
  });

  useEffect(() => {
    window.localStorage.setItem(TOOL_CALLS_EXPANDED_KEY, String(toolCallsExpanded));
  }, [toolCallsExpanded]);

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
    async (sessionId: string, input: string, model: ProviderModelSelection): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to send input to a live session.");
      }

      await window.argmax.providers.sendInput({
        sessionId,
        input: `${input}\r`,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
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
      try {
        await window.argmax.workspaces.setPinned({ workspaceId, pinned });
        await refreshDashboardStatus();
      } catch (error) {
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not toggle pin."
        });
      }
    },
    [refreshDashboardStatus]
  );

  const runCheck = useCallback(
    async (workspaceId: string, command: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Electron app window to run a check." });
        return;
      }
      try {
        await window.argmax.checks.run({ workspaceId, command });
        await refreshDashboardStatus();
      } catch (error) {
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not run check."
        });
      }
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
      try {
        await window.argmax.checkpoints.create({ workspaceId, label });
        setToast({ kind: "info", message: `Saved ${label}.` });
        await refreshDashboardStatus();
      } catch (error) {
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not save checkpoint."
        });
      }
    },
    [refreshDashboardStatus]
  );

  const terminateSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to stop a live session.");
      }
      try {
        await window.argmax.providers.terminate(sessionId);
        await Promise.all([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
      } catch (error) {
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not stop session."
        });
      }
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

  const launchTask = useCallback(
    async (prompt: string, model: ModelPickerSelection): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Electron app window to launch local agents.");
      }

      if (!selectedProject) {
        throw new Error("Register a project before launching an agent.");
      }

      const workspace = await window.argmax.workspaces.createCurrent({
        projectId: selectedProject.id,
        taskLabel: titleFromPrompt(prompt)
      });

      const launchedSession = await window.argmax.providers.launch({
        workspaceId: workspace.id,
        provider: model.provider,
        prompt,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        permissionMode,
        cols: 120,
        rows: 32
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
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
      selectedProject,
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
          setGrid(EMPTY_GRID);
          setIsSettingsOpen(false);
        }}
        onAddProject={() => void addProject()}
        onArchiveWorkspace={(id) => void handleArchiveWorkspace(id)}
        onOpenInIde={(workspaceId, ide, options) => void handleOpenInIde(workspaceId, ide, options)}
        onOpenProject={(projectId) => {
          setIsSettingsOpen(false);
          openProjectLauncher(projectId);
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenWorkspaceChat={(workspaceId, modifiers) => {
          setIsSettingsOpen(false);
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
            : grid.rows.length > 0
              ? "work-scroll session-scroll"
              : "work-scroll launcher-scroll"
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
                projects={snapshot.projects}
                onClose={() => setIsSettingsOpen(false)}
              />
            </Suspense>
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
            />
          ) : (
            <LaunchSurface
              onAddProject={() => void addProject()}
              onBranchSwitch={(updated) =>
                setSnapshot((s) => {
                  // Skip reallocation when nothing actually changed (ralph
                  // E4) — `git switch` to the same branch is a no-op.
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
                })
              }
              onLaunchTask={launchTask}
              model={launchModel}
              onModelChange={setLaunchModel}
              onSelectProject={openProjectLauncher}
              project={selectedProject}
              projects={snapshot.projects}
              rightPanelToggleSignal={rightPanelToggleSignal}
            />
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
