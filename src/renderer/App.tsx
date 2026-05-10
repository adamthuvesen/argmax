import {
  AlertTriangle,
  ChevronRight,
  Command,
  FileText,
  Folder,
  GitBranch,
  Mic,
  PanelRightClose,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  X,
} from "lucide-react";
import type { FormEvent, JSX, KeyboardEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ApprovalRequest,
  ChangedFileSummary,
  DashboardDelta,
  DashboardSnapshot,
  ProviderId,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  SkillSummary,
  TimelineEvent,
  WorkspaceDiff,
  WorkspaceSummary
} from "../shared/types.js";
import { PROVIDER_MODEL_DEFAULTS, PROVIDER_MODELS } from "../shared/providerModels.js";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import { tryParseJsonObject } from "../shared/safeJson.js";
import { stripTerminalControls } from "../shared/terminalControls.js";
import { demoSnapshot } from "./demoSnapshot.js";

const emptySnapshot: DashboardSnapshot = {
  projects: [],
  workspaces: [],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
};

type ToastMessage = { kind: "error" | "info"; message: string };
type SessionCursor = { eventCursor?: number; rawOutputCursor?: number };
type AsyncState = "idle" | "loading" | "ready" | "error";

interface ReviewState {
  files: ChangedFileSummary[];
  filesState: AsyncState;
  filesError: string | null;
  selectedFilePath: string | null;
  diff: WorkspaceDiff | null;
  diffState: AsyncState;
  diffError: string | null;
  isPanelOpen: boolean;
  isSummaryCollapsed: boolean;
  openFile: (filePath: string) => void;
  closePanel: () => void;
  toggleSummary: () => void;
}

type ParsedDiffLine = {
  kind: "addition" | "deletion" | "context";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

type ParsedDiffBlock =
  | { kind: "hunk"; id: string; header: string; lines: ParsedDiffLine[] }
  | { kind: "omitted"; id: string; count: number };

type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId };

const allModelOptions: ModelPickerSelection[] = (Object.entries(PROVIDER_MODELS) as Array<[ProviderId, typeof PROVIDER_MODELS[ProviderId]]>)
  .flatMap(([provider, models]) =>
    models.map((model) => ({
      provider,
      label: model.label,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    }))
  );

const SUGGESTION_CHIPS = [
  "Plan a feature",
  "Review changes",
  "Run checks",
  "Debug a test"
] as const;

const collapsedProjectsStorageKey = "maestro.sidebar.collapsedProjects";

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launchModel, setLaunchModel] = useState<ModelPickerSelection>(() => ({
    provider: "codex",
    ...modelDefaultForProvider("codex")
  }));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.maestro);

  const dashboardLoadToken = useRef(0);
  const dashboardDeltaRevision = useRef(0);
  const sessionCursorsRef = useRef(new Map<string, SessionCursor>());
  const resolveApprovalToken = useRef(0);
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.maestro) {
      return;
    }

    const cursor = sessionCursorsRef.current.get(sessionId);
    const data = await window.maestro.session.eventsSince({
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
      events: mergeByCreatedAt(current.events, data.events, 50, "asc"),
      rawOutputs: mergeByCreatedAt(current.rawOutputs, data.rawOutputs, 100, "asc")
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
      if (!window.maestro) {
        await loadDashboard();
        return;
      }

      const [status, approvals] = await Promise.all([
        window.maestro.workspaces.status(),
        window.maestro.approvals.pending()
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
    if (!window.maestro) {
      return;
    }
    return window.maestro.dashboard.onDelta((delta) => {
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

  const addProject = useCallback(async (): Promise<void> => {
    if (!window.maestro) {
      setToast({ kind: "error", message: "Open the Electron app window to add a project." });
      return;
    }

    try {
      const result = await window.maestro.projects.pickFolder();
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
        message: error instanceof Error ? error.message : "Maestro requires a local git repository."
      });
    }
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
      const token = ++resolveApprovalToken.current;
      const previousSnapshot = snapshot;

      // Optimistic update.
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId && approval.status === "pending"
            ? { ...approval, status, resolvedAt: new Date().toISOString() }
            : approval
        )
      }));

      if (!window.maestro) {
        return;
      }

      try {
        await window.maestro.approvals.resolve({ approvalId, status });
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
    [snapshot, refreshDashboardStatus]
  );

  const sendSessionInput = useCallback(
    async (sessionId: string, input: string, model: ProviderModelSelection): Promise<void> => {
      if (!window.maestro) {
        throw new Error("Open the Electron app window to send input to a live session.");
      }

      await window.maestro.providers.sendInput({
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

  const launchTask = useCallback(
    async (prompt: string, model: ModelPickerSelection): Promise<void> => {
      if (!window.maestro) {
        throw new Error("Open the Electron app window to launch local agents.");
      }

      if (!selectedProject) {
        throw new Error("Register a project before launching an agent.");
      }

      const workspace = await window.maestro.workspaces.createCurrent({
        projectId: selectedProject.id,
        taskLabel: titleFromPrompt(prompt)
      });

      const launchedSession = await window.maestro.providers.launch({
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

  return (
    <main className="app-shell" tabIndex={-1}>
      {bridgeMissing && !isBrowserPreview() ? (
        <div className="bridge-banner" role="alert">
          Preload bridge unavailable; running on demo data.
        </div>
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
        onOpenLauncher={() => {
          setSelectedSessionId(null);
          setSelectedWorkspaceId(null);
        }}
        onAddProject={() => void addProject()}
        onOpenProject={openProjectLauncher}
        onOpenWorkspaceChat={openWorkspaceChat}
        selectedProjectId={selectedProject?.id ?? null}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        snapshot={snapshot}
      />

      <section className="workspace">
        <div className={selectedSession ? "work-scroll session-scroll" : "work-scroll launcher-scroll"}>
          {loadState === "error" ? (
            <EmptyState message={loadError} onRetry={() => void loadDashboard()} />
          ) : selectedSession ? (
            <SessionPane
              approvals={snapshot.approvals}
              events={snapshot.events}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              project={selectedProject}
              rawOutputs={snapshot.rawOutputs}
              session={selectedSession}
              workspace={selectedWorkspace}
            />
          ) : (
            <LaunchSurface
              onAddProject={() => void addProject()}
              onLaunchTask={launchTask}
              model={launchModel}
              onModelChange={setLaunchModel}
              project={selectedProject}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function Sidebar({
  loadState,
  onAddProject,
  onOpenLauncher,
  onOpenProject,
  onOpenWorkspaceChat,
  selectedProjectId,
  selectedWorkspaceId,
  snapshot
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  onOpenLauncher: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenWorkspaceChat: (workspaceId: string) => void;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => loadCollapsedProjectIds());

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

  return (
    <aside className="sidebar" data-loading={loadState === "loading" ? "true" : undefined}>
      <div className="window-controls">
        <span className="search-shell">
          <kbd className="kbd kbd-floating" aria-hidden="true">⌘ K</kbd>
          <button className="small-icon" type="button" title="Search">
            <Search size={16} />
          </button>
        </span>
      </div>

      <div className="project-list">
        <div className="rail-heading">
          <p className="rail-label">Projects</p>
          <button className="small-icon" type="button" title="Add Project" aria-label="Add Project" onClick={onAddProject}>
            <Plus size={16} />
          </button>
        </div>
        {snapshot.projects.map((project) => {
          const projectWorkspaces = snapshot.workspaces
            .filter((workspace) => workspace.projectId === project.id)
            .slice(0, 7);
          const isCollapsed = collapsedProjectIds.has(project.id);
          return (
            <div className="project-group" data-collapsed={isCollapsed ? "true" : undefined} key={project.id}>
              <div className="project-row">
                <button
                  aria-pressed={selectedProjectId === project.id && !selectedWorkspaceId}
                  className={
                    selectedProjectId === project.id && !selectedWorkspaceId ? "project-name active" : "project-name"
                  }
                  type="button"
                  onClick={() => {
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
                    <button
                      aria-pressed={selectedWorkspaceId === workspace.id}
                      className={selectedWorkspaceId === workspace.id ? "session-link active" : "session-link"}
                      data-status={workspace.state}
                      key={workspace.id}
                      type="button"
                      onClick={() => onOpenWorkspaceChat(workspace.id)}
                    >
                      <span className="status-dot" aria-hidden="true" />
                      <span>{workspace.taskLabel}</span>
                    </button>
                  ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <span className="connection-state" data-state={loadState}>
          {loadState === "ready" ? "Online" : loadState === "loading" ? "Loading" : "Issue"}
        </span>
        <button className="small-icon" type="button" title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}

function loadCollapsedProjectIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const rawValue = window.localStorage.getItem(collapsedProjectsStorageKey);
    const projectIds: unknown = rawValue ? JSON.parse(rawValue) : [];
    return Array.isArray(projectIds) && projectIds.every((projectId) => typeof projectId === "string")
      ? new Set(projectIds)
      : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedProjectIds(projectIds: Set<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...projectIds]));
}

function SessionPane({
  approvals,
  events,
  onResolveApproval,
  onSendSessionInput,
  project,
  rawOutputs,
  session,
  workspace
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  const reviewState = useReviewState(workspace);
  const visibleApprovals = useMemo(
    () => (sessionId ? approvals.filter((approval) => approval.sessionId === sessionId) : approvals),
    [approvals, sessionId]
  );
  const visibleEvents = useMemo(
    () => (sessionId ? events.filter((event) => event.sessionId === sessionId) : events),
    [events, sessionId]
  );
  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    try {
      await onResolveApproval(approvalId, status);
    } catch {
      // Errors are surfaced through the parent toast system.
    }
  };

  return (
    <div className={reviewState.isPanelOpen ? "session-grid review-open" : "session-grid"}>
      <div className="session-main-column">
        <SessionConversation
          events={visibleEvents}
          onSendSessionInput={onSendSessionInput}
          project={project}
          rawOutputs={rawOutputs}
          review={reviewState}
          session={session}
          workspace={workspace}
        />

        {visibleApprovals.length > 0 ? (
          <section className="approval-surface">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Approvals</p>
                <h2>Risk gate</h2>
              </div>
              <ShieldAlert size={20} />
            </div>
            {visibleApprovals.map((approval) => (
              <div className="approval-row" data-risk={approval.riskLevel} key={approval.id}>
                <div className="approval-risk">
                  <strong>{approval.riskLevel}</strong>
                  <span>{approval.status}</span>
                </div>
                <div className="approval-command">
                  <code>{approval.command}</code>
                  <span>
                    {approval.provider} / {approval.cwd}
                  </span>
                </div>
                <div className="approval-actions">
                  <button
                    disabled={approval.status !== "pending"}
                    type="button"
                    onClick={() => {
                      void handleResolveApproval(approval.id, "rejected");
                    }}
                  >
                    Reject
                  </button>
                  <button
                    disabled={approval.status !== "pending"}
                    type="button"
                    onClick={() => {
                      void handleResolveApproval(approval.id, "approved");
                    }}
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>
      {reviewState.isPanelOpen ? <ReviewPanel review={reviewState} /> : null}
    </div>
  );
}

function SessionConversation({
  events,
  onSendSessionInput,
  project,
  rawOutputs,
  review,
  session,
  workspace
}: {
  events: TimelineEvent[];
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>(() => modelSelectionFromSession(session));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shouldRefocusInput = useRef(false);
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .reverse(),
    [events]
  );
  const hasAssistantEvents = conversationEvents.some((event) => event.type !== "user.message");
  const terminalTranscript = useMemo(
    () => (hasAssistantEvents ? "" : buildTerminalTranscript(rawOutputs, session?.id ?? null)),
    [rawOutputs, session?.id, hasAssistantEvents]
  );
  const latestUserMessageAt = conversationEvents
    .filter((event) => event.type === "user.message")
    .at(-1)?.createdAt ?? null;
  const hasAssistantForLatestTurn = latestUserMessageAt
    ? conversationEvents.some((event) => event.type !== "user.message" && event.createdAt > latestUserMessageAt)
    : hasAssistantEvents;
  const canSend = Boolean(
    session &&
      (["complete", "waiting"].includes(session.state) ||
        (session.provider === "codex" && session.state === "running"))
  );
  const isThinking = session?.state === "running" && !hasAssistantForLatestTurn;
  const repositoryName = project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";
  const sessionDetails = [
    session ? providerLabel(session.provider) : null,
    selectedModel.label,
    workspace?.branch ?? null
  ].filter((detail): detail is string => Boolean(detail));

  useEffect(() => {
    setSelectedModel(modelSelectionFromSession(session));
  }, [session]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, isSending]);

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null
  });

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending) {
      return;
    }

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    try {
      await onSendSessionInput(session.id, trimmedInput, selectedModel);
      setInput("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <section className="conversation-surface" aria-label="Session conversation">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Repository</p>
          <h2>{repositoryName}</h2>
          <div className="conversation-meta" aria-label="Session details">
            {sessionDetails.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </div>
        </div>
        {session ? (
          <ModelSelector
            provider={session.provider}
            value={selectedModel}
            onChange={setSelectedModel}
            ariaLabel="Session model"
          />
        ) : null}
      </div>
      <div className="conversation-list">
        {conversationEvents.length > 0 ? (
          conversationEvents.map((event) =>
            event.type === "user.message" ? (
              <article className="chat-bubble user" key={event.id}>
                <p>{event.message}</p>
              </article>
            ) : (
              <article className="chat-bubble assistant" key={event.id}>
                <div className="markdown">
                  <ReactMarkdown>{event.message}</ReactMarkdown>
                </div>
              </article>
            )
          )
        ) : terminalTranscript ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : (
          <p className="conversation-empty">Agent replies will appear here.</p>
        )}
        {terminalTranscript && !hasAssistantEvents && conversationEvents.length > 0 ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : null}
        {isThinking ? (
          <article className="chat-bubble assistant thinking-indicator" aria-live="polite" aria-label="Thinking">
            <div className="command-stream" data-testid="command-stream" aria-hidden="true">
              <span className="command-stream-glyph" />
              <span className="command-stream-line">
                <span className="command-stream-prompt">$</span>
                <span className="command-stream-text">maestro run --agent</span>
                <span className="command-stream-caret" />
              </span>
              <span className="command-stream-ticks">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="command-stream-trace" />
            </div>
          </article>
        ) : null}
      </div>
      <ChangedFilesCard review={review} />
      <form className="session-input" onSubmit={(event) => void submitInput(event)}>
        <div className="session-input-field">
          <input
            aria-label="Session prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={!canSend || isSending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={slashAutocomplete.onKeyDown}
            placeholder=""
            ref={inputRef}
            value={input}
          />
          <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
        </div>
        <button disabled={!canSend || isSending || !input.trim()} type="submit" title="Send follow-up">
          <ChevronRight size={18} />
        </button>
      </form>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function useReviewState(workspace: WorkspaceSummary | null): ReviewState {
  const [files, setFiles] = useState<ChangedFileSummary[]>([]);
  const [filesState, setFilesState] = useState<AsyncState>("idle");
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSummaryCollapsed, setIsSummaryCollapsed] = useState(false);
  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const previousWorkspaceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);

  useEffect(() => {
    isPanelOpenRef.current = isPanelOpen;
  }, [isPanelOpen]);

  useEffect(() => {
    const token = ++fileLoadToken.current;
    const workspaceId = workspace?.id ?? null;
    if (previousWorkspaceId.current !== workspaceId) {
      previousWorkspaceId.current = workspaceId;
      setSelectedFilePath(null);
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(false);
    }

    if (!workspace?.id || !window.maestro) {
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(false);
      return;
    }

    setFilesState("loading");
    setFilesError(null);
    void window.maestro.review
      .listChangedFiles(workspace.id)
      .then((result) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        const sorted = [...result].sort((left, right) => left.path.localeCompare(right.path));
        setFiles(sorted);
        setFilesState("ready");
        setSelectedFilePath((currentPath) => {
          if (currentPath && sorted.some((file) => file.path === currentPath)) {
            return currentPath;
          }
          return isPanelOpenRef.current ? sorted[0]?.path ?? null : null;
        });
        if (sorted.length === 0) {
          setIsPanelOpen(false);
        }
      })
      .catch((error) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        setFiles([]);
        setFilesState("error");
        setFilesError(error instanceof Error ? error.message : "Could not load changed files.");
      });
  }, [workspace?.id, workspace?.changedFiles, workspace?.lastActivityAt]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!workspace?.id || !selectedFilePath || !window.maestro) {
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    setDiffState("loading");
    setDiffError(null);
    void window.maestro.review
      .loadDiff(workspace.id, selectedFilePath)
      .then((result) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(result);
        setDiffState("ready");
      })
      .catch((error) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(null);
        setDiffState("error");
        setDiffError(error instanceof Error ? error.message : "Could not load diff.");
      });
  }, [workspace?.id, selectedFilePath]);

  const openFile = useCallback((filePath: string): void => {
    setSelectedFilePath(filePath);
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  const toggleSummary = useCallback((): void => {
    setIsSummaryCollapsed((current) => !current);
  }, []);

  return {
    files,
    filesState,
    filesError,
    selectedFilePath,
    diff,
    diffState,
    diffError,
    isPanelOpen,
    isSummaryCollapsed,
    openFile,
    closePanel,
    toggleSummary
  };
}

function ChangedFilesCard({ review }: { review: ReviewState }): JSX.Element | null {
  if (review.filesState === "idle" || (review.filesState === "ready" && review.files.length === 0)) {
    return null;
  }

  if (review.filesState === "loading") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header">
          <span>Loading changed files</span>
        </div>
      </section>
    );
  }

  if (review.filesState === "error") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header">
          <span>Changed files unavailable</span>
          <span className="review-error">{review.filesError}</span>
        </div>
      </section>
    );
  }

  const totals = summarizeChangedFiles(review.files);
  return (
    <section className="changed-files-card" aria-label="Changed files" data-collapsed={review.isSummaryCollapsed ? "true" : undefined}>
      <div className="changed-files-header">
        <span>{review.files.length} files changed</span>
        <span className="changed-files-actions">
          <ChangeCount additions={totals.additions} deletions={totals.deletions} />
          <button type="button" onClick={review.toggleSummary}>
            {review.isSummaryCollapsed ? "Show diff" : "Hide diff"}
          </button>
        </span>
      </div>
      {review.isSummaryCollapsed ? null : (
        <div className="changed-files-list">
          {review.files.map((file) => (
            <button
              aria-pressed={review.selectedFilePath === file.path && review.isPanelOpen}
              className="changed-file-row"
              key={file.path}
              type="button"
              onClick={() => review.openFile(file.path)}
            >
              <span className="changed-file-status">{statusLabel(file.status)}</span>
              <span className="changed-file-path">{file.path}</span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewPanel({ review }: { review: ReviewState }): JSX.Element {
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);

  return (
    <aside className="review-panel" aria-label="Review panel">
      <div className="review-toolbar">
        <div>
          <p className="eyebrow">Review</p>
          <h2>
            {review.files.length} files changed <ChangeCount additions={totals.additions} deletions={totals.deletions} />
          </h2>
        </div>
        <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="review-file-tabs" aria-label="Changed file list">
        {review.files.map((file) => (
          <button
            aria-pressed={review.selectedFilePath === file.path}
            key={file.path}
            type="button"
            onClick={() => review.openFile(file.path)}
          >
            <FileText size={15} />
            <span>{file.path}</span>
            <ChangeCount additions={file.additions} deletions={file.deletions} />
          </button>
        ))}
      </div>
      <div className="review-diff">
        {selectedFile ? (
          <div className="review-diff-heading">
            <div>
              <span className="changed-file-status">{statusLabel(selectedFile.status)}</span>
              <strong>{selectedFile.path}</strong>
              <ChangeCount additions={selectedFile.additions} deletions={selectedFile.deletions} />
            </div>
            <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
              <X size={16} />
            </button>
          </div>
        ) : null}
        {review.diffState === "loading" ? <p className="review-empty">Loading diff...</p> : null}
        {review.diffState === "error" ? <p className="review-empty review-error">{review.diffError}</p> : null}
        {review.diffState === "ready" && diffBlocks.length === 0 ? <p className="review-empty">No textual diff.</p> : null}
        {review.diffState === "ready" && diffBlocks.length > 0 ? <DiffBlocks blocks={diffBlocks} /> : null}
      </div>
    </aside>
  );
}

function DiffBlocks({ blocks }: { blocks: ParsedDiffBlock[] }): JSX.Element {
  return (
    <div className="diff-blocks">
      {blocks.map((block) =>
        block.kind === "omitted" ? (
          <div className="diff-omitted" key={block.id}>
            {block.count} unmodified lines
          </div>
        ) : (
          <div className="diff-hunk" key={block.id}>
            <div className="diff-hunk-header">{block.header}</div>
            {block.lines.map((line, index) => (
              <div className={`diff-line ${line.kind}`} key={`${block.id}-${index}`}>
                <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
                <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
                <code>{line.content || " "}</code>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="change-count" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  );
}

function summarizeChangedFiles(files: ChangedFileSummary[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  );
}

function statusLabel(status: string): string {
  if (status === "??" || status.includes("A")) {
    return "Added";
  }
  if (status.includes("D")) {
    return "Deleted";
  }
  if (status.includes("R")) {
    return "Renamed";
  }
  if (status.includes("C")) {
    return "Copied";
  }
  return "Modified";
}

function parseUnifiedDiff(content: string): ParsedDiffBlock[] {
  const lines = content.split("\n");
  const blocks: ParsedDiffBlock[] = [];
  let index = 0;
  let previousOldEnd: number | null = null;
  let hunkIndex = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
    if (!match) {
      index += 1;
      continue;
    }

    const oldStart = Number(match[1]);
    let oldLineNumber = oldStart;
    let newLineNumber = Number(match[2]);
    if (previousOldEnd !== null) {
      const omittedCount = oldStart - previousOldEnd - 1;
      if (omittedCount > 0) {
        blocks.push({ kind: "omitted", id: `omitted-${hunkIndex}`, count: omittedCount });
      }
    }

    const hunkLines: ParsedDiffLine[] = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("diff --git ")) {
        break;
      }
      if (line.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        hunkLines.push({
          kind: "addition",
          oldLineNumber: null,
          newLineNumber,
          content: line.slice(1)
        });
        newLineNumber += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        hunkLines.push({
          kind: "deletion",
          oldLineNumber,
          newLineNumber: null,
          content: line.slice(1)
        });
        oldLineNumber += 1;
      } else if (line.startsWith(" ")) {
        hunkLines.push({
          kind: "context",
          oldLineNumber,
          newLineNumber,
          content: line.slice(1)
        });
        oldLineNumber += 1;
        newLineNumber += 1;
      }
      index += 1;
    }

    blocks.push({ kind: "hunk", id: `hunk-${hunkIndex}`, header, lines: hunkLines });
    previousOldEnd = oldLineNumber - 1;
    hunkIndex += 1;
  }

  return blocks;
}

function LaunchSurface({
  model,
  onAddProject,
  onLaunchTask,
  onModelChange,
  project
}: {
  model: ModelPickerSelection;
  onAddProject: () => void;
  onLaunchTask: (prompt: string, model: ModelPickerSelection) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  project: ProjectSummary | null;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null
  });

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setStatus(null);
    try {
      await onLaunchTask(trimmedPrompt, model);
      setPrompt("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start agent.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!project) {
    return (
      <div className="launcher-surface empty-project-launcher">
        <h1>Add a project to start</h1>
        <button className="primary-action" type="button" onClick={onAddProject}>
          <Plus size={18} />
          Add Project
        </button>
      </div>
    );
  }

  return (
    <div className="launcher-surface">
      <h1>What should we build in {project.name.toLowerCase()}?</h1>
      <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
        <div className="composer-input">
          <input
            aria-label="Task prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={isSubmitting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={slashAutocomplete.onKeyDown}
            placeholder="Ask an agent to work locally"
            ref={promptInputRef}
            value={prompt}
          />
          <SkillPopover state={slashAutocomplete} inputRef={promptInputRef} />
          <button className="composer-tool" type="button" title="Add context">
            <Plus size={18} />
          </button>
          <button className="composer-tool" type="button" title="Commands">
            <Command size={18} />
          </button>
          <button className="composer-tool" type="button" title="Voice input">
            <Mic size={18} />
          </button>
          <button className="send-button" disabled={isSubmitting || !prompt.trim()} type="submit" title="Start agent">
            <kbd className="kbd kbd-hint" aria-hidden="true">⌘ ↵</kbd>
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="composer-context">
          <span>
            <GitBranch size={16} />
            main
          </span>
          <span>Work locally</span>
          <CombinedModelSelector value={model} onChange={onModelChange} ariaLabel="Launch model" />
        </div>
        <div className="suggestion-chips" aria-label="Suggestions">
          {SUGGESTION_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={isSubmitting}
              onClick={() => setPrompt(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
        {status ? (
          <p className="composer-status" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function EmptyState({ message, onRetry }: { message?: string | null; onRetry?: () => void }): JSX.Element {
  return (
    <section className="empty-state">
      <AlertTriangle size={24} />
      <h2>Local state could not be loaded</h2>
      <p>
        {message ??
          "Maestro keeps working from local storage, but the database needs attention before the dashboard can render."}
      </p>
      {onRetry ? (
        <button className="empty-state-retry" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  );
}

async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!window.maestro) {
    return demoSnapshot;
  }

  return window.maestro.dashboard.load();
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Local agent task";
}

function providerLabel(provider: ProviderId): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function repoNameFromPath(path: string | null | undefined): string | null {
  const trimmedPath = path?.replace(/\/+$/, "") ?? "";
  return trimmedPath.split("/").at(-1) || null;
}

/**
 * Returns the partial skill name when the input is a slash command being
 * composed (no whitespace yet), otherwise null. The popover only opens on
 * `/<name>` shapes; once the user adds a space (typing args) the popover
 * stays closed.
 */
function parseSlashQuery(input: string): { query: string } | null {
  if (!input.startsWith("/")) {
    return null;
  }
  const rest = input.slice(1);
  if (/\s/.test(rest)) {
    return null;
  }
  return { query: rest };
}

interface UseSlashAutocompleteArgs {
  input: string;
  setInput: (value: string) => void;
  provider: ProviderId | null;
  workspaceId: string | null;
}

interface SlashAutocompleteState {
  popoverOpen: boolean;
  filteredSkills: SkillSummary[];
  selectionIndex: number;
  setSelectionIndex: (index: number) => void;
  selectSkill: (name: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

function useSlashAutocomplete({
  input,
  setInput,
  provider,
  workspaceId
}: UseSlashAutocompleteArgs): SlashAutocompleteState {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const fetchedFor = useRef<string | null>(null);
  const slashQuery = parseSlashQuery(input);

  useEffect(() => {
    if (!slashQuery || !provider) {
      return;
    }
    const cacheKey = `${provider}::${workspaceId ?? ""}`;
    if (fetchedFor.current === cacheKey) {
      return;
    }
    fetchedFor.current = cacheKey;
    let cancelled = false;
    const api = window.maestro?.skills;
    if (!api?.list) {
      return;
    }
    void api
      .list(workspaceId ? { provider, workspaceId } : { provider })
      .then((result) => {
        if (!cancelled) {
          setSkills(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slashQuery, provider, workspaceId]);

  const filteredSkills = useMemo(() => {
    if (!slashQuery) {
      return [] as SkillSummary[];
    }
    const needle = slashQuery.query.toLowerCase();
    if (!needle) {
      return skills;
    }
    return skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  }, [skills, slashQuery]);

  const popoverOpen = slashQuery !== null && filteredSkills.length > 0;

  useEffect(() => {
    if (selectionIndex >= filteredSkills.length) {
      setSelectionIndex(0);
    }
  }, [filteredSkills.length, selectionIndex]);

  const selectSkill = (name: string): void => {
    setInput(`/${name} `);
    setSelectionIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!popoverOpen) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectionIndex((selectionIndex + 1) % filteredSkills.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectionIndex((selectionIndex - 1 + filteredSkills.length) % filteredSkills.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const choice = filteredSkills[selectionIndex];
      if (choice) {
        event.preventDefault();
        selectSkill(choice.name);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
      setSelectionIndex(0);
    }
  };

  return { popoverOpen, filteredSkills, selectionIndex, setSelectionIndex, selectSkill, onKeyDown };
}

function SkillPopover({
  state,
  inputRef
}: {
  state: SlashAutocompleteState;
  inputRef: RefObject<HTMLInputElement | null>;
}): JSX.Element | null {
  if (!state.popoverOpen) {
    return null;
  }
  return (
    <ul className="skill-popover" id="skill-popover" role="listbox" aria-label="Skill suggestions">
      {state.filteredSkills.map((skill, index) => (
        <li
          key={skill.name}
          role="option"
          aria-selected={index === state.selectionIndex}
          className={`skill-option${index === state.selectionIndex ? " is-selected" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            state.setSelectionIndex(index);
            state.selectSkill(skill.name);
            inputRef.current?.focus();
          }}
        >
          <span className="skill-option-name">/{skill.name}</span>
          {skill.description ? <span className="skill-option-description">{skill.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ModelSelector({
  ariaLabel,
  onChange,
  provider,
  value
}: {
  ariaLabel: string;
  onChange: (model: ProviderModelSelection) => void;
  provider: ProviderId;
  value: ProviderModelSelection;
}): JSX.Element {
  const models = PROVIDER_MODELS[provider];
  const selectedValue = models.some((model) => model.modelId === value.modelId) ? value.modelId : "__custom";

  return (
    <span className="model-selector">
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => {
          const modelId = event.target.value;
          if (modelId === "__custom") {
            onChange({
              label: value.modelId,
              modelId: value.modelId,
              ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {})
            });
            return;
          }
          const model = models.find((option) => option.modelId === modelId);
          if (model) {
            onChange({
              label: model.label,
              modelId: model.modelId,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
            });
          }
        }}
      >
        {models.map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.badge ? `${model.label} (${model.badge})` : model.label}
          </option>
        ))}
        <option value="__custom">Custom model</option>
      </select>
      {selectedValue === "__custom" ? (
        <input
          aria-label={`${ariaLabel} custom id`}
          value={value.modelId}
          onChange={(event) => {
            const modelId = event.target.value.trim();
            onChange({
              label: modelId || "Custom model",
              modelId: modelId || value.modelId,
              ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {})
            });
          }}
        />
      ) : null}
    </span>
  );
}

function CombinedModelSelector({
  ariaLabel,
  onChange,
  value
}: {
  ariaLabel: string;
  onChange: (model: ModelPickerSelection) => void;
  value: ModelPickerSelection;
}): JSX.Element {
  const selectedValue = allModelOptions.some(
    (model) => model.provider === value.provider && model.modelId === value.modelId
  )
    ? modelValue(value)
    : "__custom";

  return (
    <span className="model-selector model-selector-combined">
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => {
          const selected = event.target.value;
          if (selected === "__custom") {
            onChange({
              provider: value.provider,
              label: "custom-model",
              modelId: "custom-model",
              ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {})
            });
            return;
          }
          const model = allModelOptions.find((option) => modelValue(option) === selected);
          if (model) {
            onChange(model);
          }
        }}
      >
        <optgroup label="Codex">
          {PROVIDER_MODELS.codex.map((model) => (
            <option key={model.modelId} value={modelValue({ provider: "codex", ...model })}>
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Claude">
          {PROVIDER_MODELS.claude.map((model) => (
            <option key={model.modelId} value={modelValue({ provider: "claude", ...model })}>
              {model.label}
            </option>
          ))}
        </optgroup>
        <option value="__custom">Custom model</option>
      </select>
      {selectedValue === "__custom" ? (
        <input
          aria-label={`${ariaLabel} custom id`}
          value={value.modelId}
          onChange={(event) => {
            const modelId = event.target.value.trim();
            onChange({
              provider: value.provider,
              label: modelId || "Custom model",
              modelId: modelId || value.modelId,
              ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {})
            });
          }}
        />
      ) : null}
    </span>
  );
}

function modelValue(model: Pick<ModelPickerSelection, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}

function effortLabel(reasoningEffort: NonNullable<ProviderModelSelection["reasoningEffort"]>): string {
  return `${reasoningEffort[0]?.toUpperCase() ?? ""}${reasoningEffort.slice(1)}`;
}

function modelDefaultForProvider(provider: ProviderId): ProviderModelSelection {
  const model = PROVIDER_MODEL_DEFAULTS[provider];
  return {
    label: model.label,
    modelId: model.modelId,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
  };
}

function modelSelectionFromSession(session: SessionSummary | null): ProviderModelSelection {
  if (!session) {
    return modelDefaultForProvider("codex");
  }
  return {
    label: session.modelLabel,
    modelId: session.modelId,
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {})
  };
}

function buildTerminalTranscript(rawOutputs: RawProviderOutput[], sessionId: string | null): string {
  if (!sessionId) {
    return "";
  }

  const transcript = rawOutputs
    .filter((output) => output.sessionId === sessionId && ["stdout", "stderr"].includes(output.stream))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap((output) => visibleRawProviderLines(stripTerminalControls(output.content)))
    .join("")
    .trim();

  return transcript.length > 8_000 ? transcript.slice(-8_000) : transcript;
}

function visibleRawProviderLines(content: string): string[] {
  return content
    .split(/(\r?\n)/)
    .filter((part) => part === "\n" || part === "\r\n" || !isHiddenRawProviderLine(part.trim()));
}

function isHiddenRawProviderLine(line: string): boolean {
  const record = tryParseJsonObject(line);
  return record !== null && typeof record.type === "string";
}

function mergeSlice<T extends { id: string }>(
  current: T[],
  updates: T[] | undefined,
  sortBy: (item: T) => string,
  limit?: number
): T[] {
  if (!updates) {
    return current;
  }
  const merged = upsertById(current, updates);
  if (merged === current) {
    return current;
  }
  const sorted = sortByTimestamp(merged, sortBy);
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

function mergeDashboardDelta(snapshot: DashboardSnapshot, delta: DashboardDelta): DashboardSnapshot {
  const projects = delta.projects
    ? (() => {
        const merged = upsertById(snapshot.projects, delta.projects);
        return merged === snapshot.projects ? snapshot.projects : sortProjects(merged);
      })()
    : snapshot.projects;
  const workspaces = mergeSlice(snapshot.workspaces, delta.workspaces, (workspace) => workspace.lastActivityAt);
  const sessions = mergeSlice(snapshot.sessions, delta.sessions, (session) => session.lastActivityAt);
  const events = mergeSlice(snapshot.events, delta.events, (event) => event.createdAt, 50);
  const rawOutputs = mergeSlice(snapshot.rawOutputs, delta.rawOutputs, (output) => output.createdAt, 100);
  const approvals = mergeSlice(snapshot.approvals, delta.approvals, (approval) => approval.createdAt, 200);
  const checks = mergeSlice(snapshot.checks, delta.checks, (check) => check.startedAt, 200);
  const checkpoints = mergeSlice(snapshot.checkpoints, delta.checkpoints, (checkpoint) => checkpoint.createdAt, 200);

  if (
    projects === snapshot.projects &&
    workspaces === snapshot.workspaces &&
    sessions === snapshot.sessions &&
    events === snapshot.events &&
    rawOutputs === snapshot.rawOutputs &&
    approvals === snapshot.approvals &&
    checks === snapshot.checks &&
    checkpoints === snapshot.checkpoints
  ) {
    return snapshot;
  }

  return { projects, workspaces, sessions, events, rawOutputs, approvals, checks, checkpoints };
}

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  if (updates.length === 0) {
    return current;
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of updates) {
    if (byId.get(item.id) !== item) {
      changed = true;
      byId.set(item.id, item);
    }
  }
  return changed ? [...byId.values()] : current;
}

function mergeByCreatedAt<T extends { id: string; createdAt: string }>(
  current: T[],
  updates: T[],
  limit: number,
  direction: "asc" | "desc"
): T[] {
  const sorted = upsertById(current, updates).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const limited = sorted.slice(-limit);
  return direction === "asc" ? limited : limited.reverse();
}

function sortProjects(projects: DashboardSnapshot["projects"]): DashboardSnapshot["projects"] {
  return sortByTimestamp(projects, (project) => project.latestActivityAt ?? "");
}

function sortByTimestamp<T>(items: T[], getTimestamp: (item: T) => string): T[] {
  return [...items].sort((left, right) => getTimestamp(right).localeCompare(getTimestamp(left)));
}

function isBrowserPreview(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}
