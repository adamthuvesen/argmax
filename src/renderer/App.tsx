import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import type {
  CommitPreparation,
  DashboardSnapshot,
  DetectedIde,
  IdeId,
  MenuCommand,
  PrepareCommitInput
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
import { SessionPane } from "./components/SessionPane.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { SkeletonPane } from "./components/SkeletonPane.js";
import { Sidebar } from "./components/Sidebar.js";
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
  readStoredFont,
  type FontFamilyId
} from "./lib/fonts.js";
import { DEFAULT_IDE_KEY, readStoredDefaultIde } from "./lib/ide.js";
import { modelDefaultForProvider, type ModelPickerSelection } from "./lib/models.js";
import { titleFromPrompt } from "./lib/projects.js";
import { mergeDashboardDelta } from "./lib/snapshot.js";

type ToastMessage = { kind: "error" | "info"; message: string };

const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";

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
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(() => readStoredFont());
  const [detectedIdes, setDetectedIdes] = useState<DetectedIde[]>([]);
  const [defaultIde, setDefaultIde] = useState<IdeId | null>(() => readStoredDefaultIde());

  const showErrorToast = useCallback((message: string): void => {
    setToast({ kind: "error", message });
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
    openWorkspaceChat,
    openProjectLauncher,
    resolveApproval,
    pendingSelectionRef
  } = useDashboardSession(loadDashboardSnapshot, { onErrorToast: showErrorToast });

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
          setSelectedSessionId(null);
          setSelectedWorkspaceId(null);
          return;
        case "open-command-palette":
          setIsPaletteOpen(true);
          return;
        case "open-cheat-sheet":
          setIsCheatSheetOpen(true);
          return;
        case "toggle-debug-log":
        case "toggle-sidebar":
        case "check-for-updates":
          // Wired in later phase tasks (P2.06 cheat sheet, P4 review
          // surface for debug-log lift, P7 updater). Menu accelerator
          // still fires when the native menu has focus.
          return;
      }
    },
    [setIsCheatSheetOpen, setIsPaletteOpen, setIsSettingsOpen, setSelectedSessionId, setSelectedWorkspaceId]
  );

  const openSearchOverlay = useCallback((): void => setIsSearchOpen(true), [setIsSearchOpen]);
  const selectSessionFromKeybinding = useCallback(
    (session: { id: string; workspaceId: string }): void => {
      setSelectedSessionId(session.id);
      setSelectedWorkspaceId(session.workspaceId);
    },
    [setSelectedSessionId, setSelectedWorkspaceId]
  );
  const closeSettingsFromKeybinding = useCallback(
    (): void => setIsSettingsOpen(false),
    [setIsSettingsOpen]
  );
  useGlobalKeybindings({
    sessions: snapshot.sessions,
    onMenuCommand: handleMenuCommand,
    onOpenSearch: openSearchOverlay,
    onSelectSession: selectSessionFromKeybinding,
    onCloseSettings: closeSettingsFromKeybinding
  });

  useEffect(() => {
    window.localStorage.setItem(TOOL_CALLS_EXPANDED_KEY, String(toolCallsExpanded));
  }, [toolCallsExpanded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FONT_STORAGE_KEY, fontFamily);
    applyFontToDocument(fontFamily);
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

  const handleArchiveWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (!window.argmax) {
      setToast({ kind: "error", message: "Open the Electron app window to archive workspaces." });
      return;
    }
    const result = await window.argmax.workspaces.archive(workspaceId);
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
      setSelectedSessionId(null);
      setSelectedWorkspaceId(null);
      setSnapshot((current) => mergeDashboardDelta(current, { projects: [result.project] }));
      setToast({ kind: "info", message: `Added ${result.project.name}.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Argmax requires a local git repository."
      });
    }
  }, [setSelectedProjectId, setSelectedSessionId, setSelectedWorkspaceId, setSnapshot]);

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

  const prepareCommit = useCallback(
    async (input: PrepareCommitInput): Promise<CommitPreparation> => {
      if (!window.argmax) {
        const message = "Open the Electron app window to prepare a commit.";
        setToast({ kind: "error", message });
        throw new Error(message);
      }
      try {
        return await window.argmax.commits.prepare(input);
      } catch (error) {
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not prepare commit."
        });
        throw error;
      }
    },
    []
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
        cols: 120,
        rows: 32
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      setSelectedWorkspaceId(workspace.id);
      setSelectedSessionId(launchedSession.id);
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(launchedSession.id)]);
    },
    [
      selectedProject,
      refreshDashboardStatus,
      loadSessionEvents,
      pendingSelectionRef,
      setSelectedSessionId,
      setSelectedWorkspaceId
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
          setSelectedSessionId(session.id);
          setSelectedWorkspaceId(session.workspaceId);
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
        setSelectedSessionId(null);
        setSelectedWorkspaceId(null);
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
    setIsSearchOpen,
    setIsSettingsOpen,
    setSelectedProjectId,
    setSelectedSessionId,
    setSelectedWorkspaceId
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
      // Build an FTS5 query that supports the user's tokens both as a phrase
      // (relevance) and as prefix-matched terms (recall). Tokens are stripped
      // of FTS5 operator chars so a stray quote or dash can't break the query.
      const tokens = trimmed
        .split(/\s+/)
        .map((token) => token.replace(/["'()*-]/g, ""))
        .filter((token) => token.length > 0);
      if (tokens.length === 0) return [];
      const phrase = `"${tokens.join(" ")}"`;
      const prefixed = tokens.map((token) => `${token}*`).join(" ");
      const ftsQuery = `${phrase} OR (${prefixed})`;
      const hits = await window.argmax.session.search({ query: ftsQuery, limit });
      return hits.map((hit) => ({
        id: `${hit.sessionId}:${hit.eventId}`,
        sessionId: hit.sessionId,
        label: sessionLabelById.get(hit.sessionId) ?? "Unknown session",
        snippetSegments: parseFtsSnippet(hit.snippet),
        run: () => {
          const target = snapshot.sessions.find((session) => session.id === hit.sessionId);
          setIsSettingsOpen(false);
          setSelectedSessionId(hit.sessionId);
          if (target) {
            setSelectedWorkspaceId(target.workspaceId);
          }
        }
      }));
    },
    [sessionLabelById, snapshot.sessions, setIsSettingsOpen, setSelectedSessionId, setSelectedWorkspaceId]
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
              setSelectedSessionId(sessionId);
              if (target) {
                setSelectedWorkspaceId(target.workspaceId);
              }
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
      <Sidebar
        loadState={loadState}
        onToggleWorkspacePinned={(workspaceId, pinned) => void toggleWorkspacePinned(workspaceId, pinned)}
        onOpenLauncher={() => {
          setSelectedSessionId(null);
          setSelectedWorkspaceId(null);
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
        onOpenWorkspaceChat={(workspaceId) => {
          setIsSettingsOpen(false);
          openWorkspaceChat(workspaceId);
        }}
        onResizeMouseDown={onResizeMouseDown}
        isSettingsActive={isSettingsOpen}
        selectedProjectId={selectedProject?.id ?? null}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        snapshot={snapshot}
        detectedIdes={detectedIdes}
        defaultIde={defaultIde}
      />

      <section className="workspace">
        <div className={
          isSettingsOpen
            ? "work-scroll settings-scroll"
            : selectedSession
              ? "work-scroll session-scroll"
              : "work-scroll launcher-scroll"
        }>
          {loadState === "error" ? (
            <EmptyState message={loadError} onRetry={() => void loadDashboard()} />
          ) : loadState === "loading" && !selectedSession && !isSettingsOpen ? (
            <SkeletonPane />
          ) : isSettingsOpen ? (
            <SettingsPanel
              defaultModel={launchModel}
              onDefaultModelChange={setLaunchModel}
              toolCallsExpanded={toolCallsExpanded}
              onToolCallsExpandedChange={setToolCallsExpanded}
              fontFamily={fontFamily}
              onFontFamilyChange={setFontFamily}
              detectedIdes={detectedIdes}
              defaultIde={defaultIde}
              onDefaultIdeChange={setDefaultIde}
              projects={snapshot.projects}
              onClose={() => setIsSettingsOpen(false)}
            />
          ) : selectedSession ? (
            <SessionPane
              approvals={snapshot.approvals}
              defaultToolCallsExpanded={toolCallsExpanded}
              events={snapshot.events}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              onTerminateSession={terminateSession}
              onCreateCheckpoint={createCheckpoint}
              onPrepareCommit={prepareCommit}
              onRunCheck={runCheck}
              checks={snapshot.checks}
              project={selectedProject}
              rawOutputs={snapshot.rawOutputs}
              session={selectedSession}
              workspace={selectedWorkspace}
            />
          ) : (
            <LaunchSurface
              onAddProject={() => void addProject()}
              onBranchSwitch={(updated) => setSnapshot((s) => ({ ...s, projects: s.projects.map((p) => p.id === updated.id ? updated : p) }))}
              onLaunchTask={launchTask}
              model={launchModel}
              onModelChange={setLaunchModel}
              onSelectProject={openProjectLauncher}
              project={selectedProject}
              projects={snapshot.projects}
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
