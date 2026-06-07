import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX
} from "react";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import type {
  AgentMode,
  ComposerAttachment,
  IdeId,
  MenuCommand,
  ProjectSummary
} from "../shared/types.js";
import type { MessageHit as PaletteMessageHit } from "./components/CommandPalette.js";
import { parseFtsSnippet } from "./lib/paletteSearch.js";
import { usePersistedSetting } from "./hooks/usePersistedSetting.js";
import { EmptyState } from "./components/EmptyState.js";
import { KeyboardCheatSheet } from "./components/KeyboardCheatSheet.js";
import { LaunchSurface } from "./components/LaunchSurface.js";
import { PerfOverlay } from "./components/PerfOverlay.js";
import { SessionMultiGrid } from "./components/SessionMultiGrid.js";
import { SkeletonPane } from "./components/SkeletonPane.js";
import { Sidebar } from "./components/Sidebar.js";
import { EMPTY_GRID, focusedCell, isSessionCell, openWorkspaceInGrid } from "./lib/gridState.js";
// demoSnapshot is dynamic-imported inside `loadDashboardSnapshot` so it stays
// out of the production renderer bundle. Browser-preview mode (no Tauri
// bridge) is the only consumer; packaged builds always have window.argmax.
import { useAppGridSelection } from "./hooks/useAppGridSelection.js";
import { useDashboardSession } from "./hooks/useDashboardSession.js";
import {
  CommandPalette,
  SearchOverlay,
  SettingsPanel,
  useLazyOverlayPrefetch,
  WorkspaceContentSearchOverlay
} from "./hooks/useLazyOverlayPrefetch.js";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings.js";
import { useOverlays } from "./hooks/useOverlays.js";
import { useSidebarResize } from "./hooks/useSidebarResize.js";
import { isBrowserPreview } from "./lib/env.js";
import { animateThemeChange } from "./lib/theme.js";
import { titleFromPrompt } from "./lib/projects.js";
import type { WorkspaceMode } from "./lib/workspaceMode.js";
import { modelDefaultForProvider, type ModelPickerSelection } from "./lib/models.js";
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
import {
  CHAT_COST_KEY,
  LAUNCHER_GLOBE_KEY,
  SIDEBAR_TOKENS_KEY,
  THINKING_EXPANDED_KEY,
  TOOL_CALL_GROUPS_EXPANDED_KEY,
  TOOL_CALLS_EXPANDED_KEY,
  useBooleanUiPreference
} from "./lib/uiPreferences.js";
import { loadDashboardSnapshot } from "./lib/loadDashboardSnapshot.js";
import { buildPaletteCommands, buildSessionLabelById } from "./lib/buildPaletteCommands.js";
import { useLauncherAppearance } from "./hooks/useLauncherAppearance.js";
import { markFirstContent, markFirstPaint } from "./lib/paintTimings.js";
import { mergeDashboardDelta } from "./lib/snapshot.js";

import { withToast, type ToastMessage } from "./lib/withToast.js";

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
  const [toolCallsExpanded, setToolCallsExpanded] = useBooleanUiPreference(TOOL_CALLS_EXPANDED_KEY, true);
  const [toolCallGroupsExpanded, setToolCallGroupsExpanded] = useBooleanUiPreference(
    TOOL_CALL_GROUPS_EXPANDED_KEY,
    true
  );
  const [sidebarTokensVisible, setSidebarTokensVisible] = useBooleanUiPreference(SIDEBAR_TOKENS_KEY, false);
  const [chatCostVisible, setChatCostVisible] = useBooleanUiPreference(CHAT_COST_KEY, true);
  const [launcherGlobeVisible, setLauncherGlobeVisible] = useBooleanUiPreference(LAUNCHER_GLOBE_KEY, true);
  const [thinkingExpanded, setThinkingExpanded] = useBooleanUiPreference(THINKING_EXPANDED_KEY, false);
  const { themeMode, setThemeMode, fontFamily, setFontFamily, defaultIde, setDefaultIde, detectedIdes } =
    useLauncherAppearance();
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readStoredPermissionMode());
  const [thinkingStyle, setThinkingStyle] = useState<ThinkingStyle>(() => readStoredThinkingStyle());
  const [newSessionMode, setNewSessionMode] = useState<NewSessionMode>(() => readStoredNewSessionMode());
  // `full` new-session mode hides the grid and renders LaunchSurface in its
  // place when ⌘N fires from inside an active grid. The flag is purely local
  // — it never persists; only the user's choice in Settings persists.
  const [isFullLauncherOpen, setIsFullLauncherOpen] = useState<boolean>(false);
  const [isWorkspaceDropPreviewVisible, setIsWorkspaceDropPreviewVisible] = useState(false);
  const [rightPanelToggleSignal, setRightPanelToggleSignal] = useState(0);
  const [debugLogToggleSignal, setDebugLogToggleSignal] = useState(0);
  const [terminalToggleSignal, setTerminalToggleSignal] = useState(0);
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
    openLauncherPaneInGrid
  } = useAppGridSelection({
    snapshot,
    selectedProject,
    selectedWorkspace,
    pendingSelectionRef,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    setSelectedProjectId,
    showErrorToast
  });
  const showWorkspaceDropTarget = draggingWorkspaceId !== null && !isSettingsOpen && (grid.rows.length === 0 || isFullLauncherOpen);

  useEffect(() => {
    if (!showWorkspaceDropTarget) setIsWorkspaceDropPreviewVisible(false);
  }, [showWorkspaceDropTarget]);

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
    if (newSessionMode === "full" && grid.rows.length > 0) {
      setIsFullLauncherOpen(true);
      return;
    }
    openLauncherPaneInGrid();
  }, [grid.rows.length, newSessionMode, openLauncherPaneInGrid]);

  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      switch (command) {
        case "open-settings":
          setIsPaletteOpen(false);
          setIsFullLauncherOpen(false);
          setIsSettingsOpen(!isSettingsOpen);
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
          setDebugLogToggleSignal((signal) => signal + 1);
          return;
        case "check-for-updates":
          return;
      }
    },
    [isSettingsOpen, openNewSessionPane, setIsCheatSheetOpen, setIsPaletteOpen, setIsSettingsOpen]
  );

  const openSearchOverlay = useCallback((): void => setIsSearchOpen(true), [setIsSearchOpen]);
  const openContentSearchOverlay = useCallback(
    (): void => setIsContentSearchOpen(true),
    [setIsContentSearchOpen]
  );
  const toggleIntegratedTerminal = useCallback((): void => {
    const focused = focusedCell(grid);
    let workspaceId = focused && isSessionCell(focused) ? focused.workspaceId : null;

    if (!workspaceId) {
      for (const row of grid.rows) {
        const sessionCell = row.find(isSessionCell);
        if (sessionCell) {
          workspaceId = sessionCell.workspaceId;
          break;
        }
      }
    }

    workspaceId ??= selectedWorkspace?.id ?? selectedSession?.workspaceId ?? snapshot.sessions[0]?.workspaceId ?? null;
    if (!workspaceId) {
      setToast({ kind: "error", message: "Open a session before toggling the terminal." });
      return;
    }

    setIsPaletteOpen(false);
    setIsCheatSheetOpen(false);
    setIsSearchOpen(false);
    setIsContentSearchOpen(false);
    setIsSettingsOpen(false);
    setIsFullLauncherOpen(false);
    openWorkspaceChat(workspaceId, { ctrlOrMeta: false, alt: false });
    setTerminalToggleSignal((signal) => signal + 1);
  }, [
    grid,
    openWorkspaceChat,
    selectedSession?.workspaceId,
    selectedWorkspace?.id,
    setIsCheatSheetOpen,
    setIsContentSearchOpen,
    setIsPaletteOpen,
    setIsSearchOpen,
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
    onOpenSearch: openSearchOverlay,
    onOpenContentSearch: openContentSearchOverlay,
    onToggleTerminal: toggleIntegratedTerminal,
    onSelectSession: selectSessionFromKeybinding,
    onCloseSettings: closeSettingsFromKeybinding
  });

  usePersistedSetting(PERMISSION_MODE_KEY, permissionMode);
  usePersistedSetting(THINKING_STYLE_KEY, thinkingStyle);
  usePersistedSetting(NEW_SESSION_MODE_KEY, newSessionMode);

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
    setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result] }));
    // Without force a dirty worktree comes back as "kept" — the row stays
    // in the sidebar (filter only hides "archived"). With force, that
    // branch is unreachable. Either way, fall through to inform the user
    // when the workspace did not actually archive.
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

  const sendSessionInput = useCallback(
    async (
      sessionId: string,
      input: string,
      model: ProviderModelSelection,
      agentMode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to send input to a live session.");
      }

      const result = await window.argmax.providers.sendInput({
        sessionId,
        input,
        modelLabel: model.label,
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort ?? null,
        agentMode,
        attachments: attachments?.length ? attachments : null
      });
      // Queued messages don't write a user.message event yet — the chip in the
      // pending lane is the only renderer-visible artifact, and that arrives
      // via dashboard:delta. Skip the targeted event refresh to avoid a stale
      // empty page racing the delta.
      if (result.queued) {
        await refreshDashboardStatus();
        return;
      }
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

  const cancelQueuedMessage = useCallback(
    async (sessionId: string, messageId: string): Promise<void> => {
      if (!window.argmax) return;
      await window.argmax.providers.cancelQueuedMessage({ sessionId, messageId });
    },
    []
  );

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
  const onOpenProjectRow = useCallback(
    (projectId: string): void => {
      setIsSettingsOpen(false);
      setIsFullLauncherOpen(false);
      setGrid(EMPTY_GRID);
      openProjectLauncher(projectId);
    },
    [openProjectLauncher, setIsSettingsOpen, setIsFullLauncherOpen, setGrid]
  );
  const onOpenSettingsRow = useCallback((): void => {
    setIsFullLauncherOpen(false);
    setIsSettingsOpen(true);
  }, [setIsFullLauncherOpen, setIsSettingsOpen]);
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
    openNewSessionPane();
  }, [openNewSessionPane, setIsSettingsOpen]);

  const runCheck = useCallback(
    async (workspaceId: string, command: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to run a check." });
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
        setToast({ kind: "error", message: "Open the Tauri app window to save checkpoints." });
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
        throw new Error("Open the Tauri app window to stop a live session.");
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
      const workspace =
        workspaceMode === "worktree"
          ? await window.argmax.workspaces.createIsolated({
              projectId,
              taskLabel,
              baseRef: launchingProject?.currentBranch ?? null
            })
          : await window.argmax.workspaces.createCurrent({ projectId, taskLabel });

      const launchedSession = await window.argmax.providers.launch({
        workspaceId: workspace.id,
        provider: model.provider,
        prompt,
        modelLabel: model.label,
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort ?? null,
        agentMode,
        permissionMode,
        cols: 120,
        rows: 32,
        attachments: attachments?.length ? attachments : null
      });

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
      selectedProject,
      snapshot.projects,
      refreshDashboardStatus,
      loadSessionEvents,
      pendingSelectionRef,
      permissionMode,
      setGrid,
      setIsFullLauncherOpen,
      setSnapshot
    ]
  );

  const paletteCommands = useMemo(
    () =>
      buildPaletteCommands({
        snapshot,
        selectedSession,
        onNewSession: () => handleMenuCommand("new-session"),
        onOpenSettings: () => setIsSettingsOpen(true),
        onOpenSearch: () => setIsSearchOpen(true),
        onStopSession: (sessionId) => void terminateSession(sessionId),
        onOpenWorkspace: openWorkspaceChat,
        onSelectProject: setSelectedProjectId,
        onClearGrid: () => setGrid(EMPTY_GRID),
        onCloseOverlays: () => setIsSettingsOpen(false)
      }),
    [
      snapshot,
      selectedSession,
      handleMenuCommand,
      terminateSession,
      openWorkspaceChat,
      setIsSearchOpen,
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

  const handleBranchSwitch = useCallback(
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
    // grid renders launcher cells with explicit project arguments.
    (project: ProjectSummary | null): JSX.Element => (
      <LaunchSurface
        onAddProject={() => void addProject()}
        onBranchSwitch={handleBranchSwitch}
        onLaunchTask={(prompt, model, agentMode, workspaceMode, attachments) => launchTask(prompt, model, agentMode, project?.id, workspaceMode, attachments)}
        model={launchModel}
        onModelChange={setLaunchModel}
        onSelectProject={openProjectLauncher}
        project={project ?? selectedProject}
        projects={snapshot.projects}
        rightPanelToggleSignal={rightPanelToggleSignal}
        registerPaletteFileContext={registerPaletteFileContext}
        globeEnabled={launcherGlobeVisible}
      />
    ),
    [
      addProject,
      handleBranchSwitch,
      launchModel,
      launchTask,
      launcherGlobeVisible,
      openProjectLauncher,
      registerPaletteFileContext,
      rightPanelToggleSignal,
      selectedProject,
      snapshot.projects
    ]
  );

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
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      data-resizing={isResizing ? "true" : undefined}
    >
      {bridgeMissing && !isBrowserPreview() ? (
        <div className="bridge-banner" role="alert">
          Tauri bridge unavailable; running on demo data.
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
        onToggleWorkspacePinned={onToggleWorkspacePinnedRow}
        onRenameWorkspace={onRenameWorkspaceRow}
        onOpenLauncher={onOpenLauncherRow}
        onAddProject={onAddProjectRow}
        onRemoveProject={onRemoveProjectRow}
        onArchiveWorkspace={onArchiveWorkspaceRow}
        onOpenInIde={onOpenInIdeRow}
        onOpenProject={onOpenProjectRow}
        onOpenSettings={onOpenSettingsRow}
        onOpenWorkspaceChat={onOpenWorkspaceChatRow}
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
                toolCallGroupsExpanded={toolCallGroupsExpanded}
                onToolCallGroupsExpandedChange={setToolCallGroupsExpanded}
                sidebarTokensVisible={sidebarTokensVisible}
                onSidebarTokensVisibleChange={setSidebarTokensVisible}
                chatCostVisible={chatCostVisible}
                onChatCostVisibleChange={setChatCostVisible}
                launcherGlobeVisible={launcherGlobeVisible}
                onLauncherGlobeVisibleChange={setLauncherGlobeVisible}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                fontFamily={fontFamily}
                onFontFamilyChange={setFontFamily}
                themeMode={themeMode}
                onThemeModeChange={(mode) => {
                  animateThemeChange();
                  setThemeMode(mode);
                }}
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
              defaultToolCallGroupsExpanded={toolCallGroupsExpanded}
              defaultThinkingExpanded={thinkingExpanded}
              showCostPanel={chatCostVisible}
              thinkingStyle={thinkingStyle}
              rightPanelToggleSignal={rightPanelToggleSignal}
              debugLogToggleSignal={debugLogToggleSignal}
              terminalToggleSignal={terminalToggleSignal}
              renderLauncher={renderLaunchSurface}
              dragSourceWorkspaceId={draggingWorkspaceId}
              onFocusPane={focusPane}
              onClosePane={closePane}
              onDropWorkspace={handleDropWorkspace}
              onLoadSessionEvents={loadSessionEvents}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              onCancelQueuedMessage={cancelQueuedMessage}
              pendingMessages={snapshot.pendingMessages}
              onTerminateSession={terminateSession}
              onCreateCheckpoint={createCheckpoint}
              onRunCheck={runCheck}
              registerPaletteFileContext={registerPaletteFileContext}
            />
          ) : (
            renderLaunchSurface(selectedProject)
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
    </main>
  );
}
