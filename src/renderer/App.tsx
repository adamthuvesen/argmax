import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import type {
  CommitPreparation,
  DashboardSnapshot,
  DetectedIde,
  IdeId,
  MenuCommand,
  PrepareCommitInput
} from "../shared/types.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { EmptyState } from "./components/EmptyState.js";
import { KeyboardCheatSheet } from "./components/KeyboardCheatSheet.js";
import { LaunchSurface } from "./components/LaunchSurface.js";
import { SessionPane } from "./components/SessionPane.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { demoSnapshot } from "./demoSnapshot.js";
import { isBrowserPreview } from "./lib/env.js";
import { isTypingTarget } from "./lib/typingTarget.js";
import { DEFAULT_IDE_KEY, readStoredDefaultIde } from "./lib/ide.js";
import { modelDefaultForProvider, type ModelPickerSelection } from "./lib/models.js";
import { titleFromPrompt } from "./lib/projects.js";
import {
  emptySnapshot,
  mergeByCreatedAt,
  mergeDashboardDelta,
  pruneSupersededDeltas
} from "./lib/snapshot.js";

type ToastMessage = { kind: "error" | "info"; message: string };
type SessionCursor = { eventCursor?: number; rawOutputCursor?: number };

const SIDEBAR_WIDTH_KEY = "argmax.sidebar.width";
const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 272;

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  // Mirror snapshot into a ref so callbacks that need a "current value at
  // call time" reference (e.g. resolveApproval's optimistic-rollback target)
  // don't have to depend on snapshot — which would rebuild their identity on
  // every dashboard delta and defeat downstream memoization.
  const snapshotRef = useRef<DashboardSnapshot>(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launchModel, setLaunchModel] = useState<ModelPickerSelection>(() => ({
    provider: "claude",
    ...modelDefaultForProvider("claude")
  }));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);
  const [isCheatSheetOpen, setIsCheatSheetOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.argmax);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
  });
  const [toolCallsExpanded, setToolCallsExpanded] = useState<boolean>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(TOOL_CALLS_EXPANDED_KEY) : null;
    return raw === null ? true : raw === "true";
  });
  const [isResizing, setIsResizing] = useState(false);
  const [detectedIdes, setDetectedIdes] = useState<DetectedIde[]>([]);
  const [defaultIde, setDefaultIde] = useState<IdeId | null>(() => readStoredDefaultIde());

  const dashboardLoadToken = useRef(0);
  const dashboardDeltaRevision = useRef(0);
  const sessionCursorsRef = useRef(new Map<string, SessionCursor>());
  const resolveApprovalToken = useRef(0);
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    // Errors stick until the user dismisses — losing them on a 4 s timer
    // means a blink can hide why a launch failed. Info toasts auto-dismiss.
    if (toast.kind === "error") return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      if (isSettingsOpen) {
        event.preventDefault();
        setIsSettingsOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSettingsOpen]);

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
    []
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;
      const digit = parseInt(event.key, 10);
      if (Number.isFinite(digit) && digit >= 1 && digit <= 9) {
        const targetSession = snapshot.sessions[digit - 1];
        if (!targetSession) return;
        event.preventDefault();
        setIsSettingsOpen(false);
        setSelectedSessionId(targetSession.id);
        setSelectedWorkspaceId(targetSession.workspaceId);
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        handleMenuCommand("open-settings");
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        handleMenuCommand("new-session");
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        handleMenuCommand("open-command-palette");
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        handleMenuCommand("open-cheat-sheet");
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [snapshot.sessions, handleMenuCommand]);

  useEffect(() => {
    if (!window.argmax) return;
    return window.argmax.menu.onCommand(handleMenuCommand);
  }, [handleMenuCommand]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(TOOL_CALLS_EXPANDED_KEY, String(toolCallsExpanded));
  }, [toolCallsExpanded]);

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

  // Captures the listener-removal + body-style-reset for any drag currently
  // in flight. Used by the unmount cleanup below so a mid-drag unmount
  // doesn't leave document-level listeners or a frozen cursor behind.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  const handleResizeMouseDown = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent): void => {
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + (e.clientX - startX)));
      setSidebarWidth(next);
    };
    const cleanup = (): void => {
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = null;
    };
    const onMouseUp = (): void => cleanup();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    dragCleanupRef.current = cleanup;
  }, [sidebarWidth]);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.argmax) {
      return;
    }

    const cursor = sessionCursorsRef.current.get(sessionId);
    const data = await window.argmax.session.eventsSince({
      sessionId,
      ...(cursor?.eventCursor !== undefined ? { eventCursor: cursor.eventCursor } : {}),
      ...(cursor?.rawOutputCursor !== undefined ? { rawOutputCursor: cursor.rawOutputCursor } : {})
    });
    sessionCursorsRef.current.set(sessionId, {
      eventCursor: data.eventCursor,
      rawOutputCursor: data.rawOutputCursor
    });
    setSnapshot((current) => ({
      ...current,
      events: pruneSupersededDeltas(mergeByCreatedAt(current.events, data.events, 500, "desc")),
      rawOutputs: mergeByCreatedAt(current.rawOutputs, data.rawOutputs, 100, "desc")
    }));
  }, []);

  const loadDashboard = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    const deltaRevision = dashboardDeltaRevision.current;
    try {
      const data = await loadDashboardSnapshot();
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot((current) => (deltaRevision === dashboardDeltaRevision.current ? data : mergeDashboardDelta(data, current)));
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard load failed");
    }
  }, []);

  const refreshDashboardStatus = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    try {
      if (!window.argmax) {
        await loadDashboard();
        return;
      }

      const [status, approvals] = await Promise.all([
        window.argmax.workspaces.status(),
        window.argmax.approvals.pending()
      ]);
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        ...status,
        approvals
      }));
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard refresh failed");
    }
  }, [loadDashboard]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!window.argmax) {
      return;
    }
    return window.argmax.dashboard.onDelta((delta) => {
      dashboardDeltaRevision.current += 1;
      setSnapshot((current) => mergeDashboardDelta(current, delta));
      setLoadState("ready");
      setLoadError(null);
    });
  }, []);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshDashboardStatus();
      if (selectedSessionId) {
        void loadSessionEvents(selectedSessionId);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refreshDashboardStatus, selectedSessionId, loadSessionEvents]);

  // Drop session-cursor entries for sessions that have left the snapshot
  // (archived workspace, restart) so the Map doesn't grow without bound.
  useEffect(() => {
    const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
    const cursors = sessionCursorsRef.current;
    for (const id of cursors.keys()) {
      if (!sessionIds.has(id)) {
        cursors.delete(id);
      }
    }
  }, [snapshot.sessions]);

  // Reconcile selectedSessionId against the snapshot without clobbering a
  // just-launched session while its dashboard refresh is still in flight.
  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    const selectedSession = snapshot.sessions.find((session) => session.id === selectedSessionId);
    if (selectedSession) {
      if (pendingSelectionRef.current?.sessionId === selectedSessionId) {
        pendingSelectionRef.current = null;
      }
      if (selectedWorkspaceId !== selectedSession.workspaceId) {
        setSelectedWorkspaceId(selectedSession.workspaceId);
      }
      return;
    }

    if (pendingSelectionRef.current?.sessionId === selectedSessionId) {
      if (selectedWorkspaceId !== pendingSelectionRef.current.workspaceId) {
        setSelectedWorkspaceId(pendingSelectionRef.current.workspaceId);
      }
      return;
    }

    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [snapshot.sessions, selectedSessionId, selectedWorkspaceId]);

  const selectedSession = useMemo(
    () =>
      (selectedSessionId ? snapshot.sessions.find((session) => session.id === selectedSessionId) : null) ??
      (selectedWorkspaceId ? snapshot.sessions.find((session) => session.workspaceId === selectedWorkspaceId) : null) ??
      null,
    [snapshot.sessions, selectedSessionId, selectedWorkspaceId]
  );
  const selectedWorkspace = useMemo(
    () =>
      (selectedSession ? snapshot.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId) : null) ??
      (selectedWorkspaceId ? snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : null) ??
      null,
    [snapshot.workspaces, selectedWorkspaceId, selectedSession]
  );
  const selectedProject = useMemo(
    () =>
      (selectedProjectId ? snapshot.projects.find((project) => project.id === selectedProjectId) : null) ??
      snapshot.projects[0] ??
      null,
    [snapshot.projects, selectedProjectId]
  );

  useEffect(() => {
    if (selectedWorkspace) {
      const workspaceProjectId = selectedWorkspace.projectId;
      if (selectedProjectId !== workspaceProjectId) {
        setSelectedProjectId(workspaceProjectId);
      }
      return;
    }

    if (selectedProjectId && snapshot.projects.some((project) => project.id === selectedProjectId)) {
      return;
    }

    setSelectedProjectId(snapshot.projects[0]?.id ?? null);
  }, [snapshot.projects, selectedProjectId, selectedWorkspace]);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }
    void loadSessionEvents(selectedSession.id);
  }, [selectedSession?.id, loadSessionEvents]);

  const openWorkspaceChat = useCallback(
    (workspaceId: string): void => {
      const workspace = snapshot.workspaces.find((item) => item.id === workspaceId) ?? null;
      const session = snapshot.sessions.find((item) => item.workspaceId === workspaceId) ?? null;
      setSelectedProjectId(workspace?.projectId ?? null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedSessionId(session?.id ?? null);
    },
    [snapshot.sessions, snapshot.workspaces]
  );

  const openProjectLauncher = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, []);

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
  }, [selectedWorkspaceId]);

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
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
      const token = ++resolveApprovalToken.current;
      // Use the ref so the callback's identity doesn't depend on `snapshot`;
      // depending on snapshot would rebuild this callback on every dashboard
      // delta, defeating memoization in every consumer that takes it as a
      // prop.
      const previousSnapshot = snapshotRef.current;

      // Optimistic update.
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId && approval.status === "pending"
            ? { ...approval, status, resolvedAt: new Date().toISOString() }
            : approval
        )
      }));

      if (!window.argmax) {
        return;
      }

      try {
        await window.argmax.approvals.resolve({ approvalId, status });
        if (token !== resolveApprovalToken.current) {
          return;
        }
        await refreshDashboardStatus();
      } catch (error) {
        if (token !== resolveApprovalToken.current) {
          return;
        }
        setSnapshot(previousSnapshot);
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not resolve approval."
        });
      }
    },
    [refreshDashboardStatus]
  );

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
    [selectedProject, refreshDashboardStatus, loadSessionEvents]
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

    const sessions: PaletteCommand[] = snapshot.sessions.slice(0, 20).map((session) => ({
      id: `session:${session.id}`,
      label: session.prompt.slice(0, 80) || session.modelLabel,
      subtitle: `${session.modelLabel} · ${session.state}`,
      group: "Sessions",
      run: () => {
        setIsSettingsOpen(false);
        setSelectedSessionId(session.id);
        setSelectedWorkspaceId(session.workspaceId);
      }
    }));

    const projects: PaletteCommand[] = snapshot.projects.slice(0, 20).map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      subtitle: project.repoPath,
      group: "Projects",
      run: () => {
        setIsSettingsOpen(false);
        setSelectedProjectId(project.id);
        setSelectedSessionId(null);
        setSelectedWorkspaceId(null);
      }
    }));

    return [...actions, ...sessions, ...projects];
  }, [snapshot.sessions, snapshot.projects, selectedSession, handleMenuCommand, terminateSession]);

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
      <CommandPalette
        open={isPaletteOpen}
        commands={paletteCommands}
        onClose={() => setIsPaletteOpen(false)}
      />
      <KeyboardCheatSheet open={isCheatSheetOpen} onClose={() => setIsCheatSheetOpen(false)} />
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
        onResizeMouseDown={handleResizeMouseDown}
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
          ) : isSettingsOpen ? (
            <SettingsPanel
              defaultModel={launchModel}
              onDefaultModelChange={setLaunchModel}
              toolCallsExpanded={toolCallsExpanded}
              onToolCallsExpandedChange={setToolCallsExpanded}
              detectedIdes={detectedIdes}
              defaultIde={defaultIde}
              onDefaultIdeChange={setDefaultIde}
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
    return demoSnapshot;
  }

  const snapshot = await window.argmax.dashboard.load();
  return { ...snapshot, events: pruneSupersededDeltas(snapshot.events) };
}

