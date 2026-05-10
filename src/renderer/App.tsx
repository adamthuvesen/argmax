import {
  AlertTriangle,
  ChevronRight,
  Command,
  Folder,
  GitBranch,
  Mic,
  Plus,
  Search,
  Settings,
  ShieldAlert,
} from "lucide-react";
import type { FormEvent, JSX, KeyboardEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ApprovalRequest,
  DashboardDelta,
  DashboardSnapshot,
  ProviderId,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  SkillSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../shared/types.js";
import { PROVIDER_MODEL_DEFAULTS } from "../shared/providerModels.js";
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

/* eslint-disable no-control-regex */
const oscSequencePattern = new RegExp("\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)", "g");
const csiSequencePattern = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
const escapeSequencePattern = new RegExp("\\u001B[@-Z\\\\-_]", "g");
const controlCharacterPattern = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");
/* eslint-enable no-control-regex */

const providerOptions: Array<{ id: ProviderId; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" }
];

const SUGGESTION_CHIPS = [
  "Plan a feature",
  "Review changes",
  "Run checks",
  "Debug a test"
] as const;

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerOverride, setProviderOverride] = useState<ProviderId | null>(null);
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
    if (!window.maestro?.session?.eventsSince) {
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
      const statusLoader = window.maestro?.workspaces.status;
      const approvalsLoader = window.maestro?.approvals.pending;
      if (!statusLoader || !approvalsLoader) {
        await loadDashboard();
        return;
      }

      const [status, approvals] = await Promise.all([statusLoader(), approvalsLoader()]);
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
    const unsubscribe = window.maestro?.dashboard.onDelta?.((delta) => {
      dashboardDeltaRevision.current += 1;
      setSnapshot((current) => mergeDashboardDelta(current, delta));
      setLoadState("ready");
      setLoadError(null);
    });
    if (!unsubscribe) {
      return;
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadDashboard();
      if (selectedSessionId) {
        void loadSessionEvents(selectedSessionId);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadDashboard, selectedSessionId, loadSessionEvents]);

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
  const selectedProvider = providerOverride ?? selectedProject?.settings.defaultProvider ?? "codex";

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
    if (!window.maestro?.projects.pickFolder) {
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
      await loadDashboard();
      setSnapshot((current) => mergeDashboardDelta(current, { projects: [result.project] }));
      setToast({ kind: "info", message: `Added ${result.project.name}.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Maestro requires a local git repository."
      });
    }
  }, [loadDashboard]);

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

      if (!window.maestro?.approvals.resolve) {
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
    async (sessionId: string, input: string): Promise<void> => {
      if (!window.maestro?.providers.sendInput) {
        throw new Error("Open the Electron app window to send input to a live session.");
      }

      await window.maestro.providers.sendInput({
        sessionId,
        input: `${input}\r`
      });
      await Promise.all([loadDashboard(), loadSessionEvents(sessionId)]);
    },
    [loadDashboard, loadSessionEvents]
  );

  const launchTask = useCallback(
    async (prompt: string, provider: ProviderId): Promise<void> => {
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

      const modelDefault = modelDefaultForProvider(provider);
      const launchedSession = await window.maestro.providers.launch({
        workspaceId: workspace.id,
        provider,
        prompt,
        modelLabel: modelDefault.label,
        modelId: modelDefault.modelId,
        ...(modelDefault.reasoningEffort ? { reasoningEffort: modelDefault.reasoningEffort } : {}),
        cols: 120,
        rows: 32
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      setSelectedWorkspaceId(workspace.id);
      setSelectedSessionId(launchedSession.id);
      await Promise.all([loadDashboard(), loadSessionEvents(launchedSession.id)]);
    },
    [selectedProject, loadDashboard, loadSessionEvents]
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
              rawOutputs={snapshot.rawOutputs}
              session={selectedSession}
              workspace={selectedWorkspace}
            />
          ) : (
            <LaunchSurface
              onAddProject={() => void addProject()}
              onLaunchTask={launchTask}
              onProviderChange={setProviderOverride}
              project={selectedProject}
              provider={selectedProvider}
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
        {snapshot.projects.map((project) => (
          <div className="project-group" key={project.id}>
            <button
              aria-pressed={selectedProjectId === project.id && !selectedWorkspaceId}
              className={selectedProjectId === project.id && !selectedWorkspaceId ? "project-name active" : "project-name"}
              type="button"
              onClick={() => {
                onOpenProject(project.id);
                onOpenLauncher();
              }}
            >
              <Folder size={16} />
              <span>{project.name}</span>
            </button>
            {snapshot.workspaces
              .filter((workspace) => workspace.projectId === project.id)
              .slice(0, 7)
              .map((workspace) => (
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
        ))}
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

function SessionPane({
  approvals,
  events,
  onResolveApproval,
  onSendSessionInput,
  rawOutputs,
  session,
  workspace
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string) => Promise<void>;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const sessionId = session?.id ?? null;
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
    <div className="session-grid">
      <SessionConversation
        events={visibleEvents}
        onSendSessionInput={onSendSessionInput}
        rawOutputs={rawOutputs}
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
  );
}

function SessionConversation({
  events,
  onSendSessionInput,
  rawOutputs,
  session,
  workspace
}: {
  events: TimelineEvent[];
  onSendSessionInput: (sessionId: string, input: string) => Promise<void>;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shouldRefocusInput = useRef(false);
  const conversationEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [events]
  );
  const terminalTranscript = useMemo(
    () => buildTerminalTranscript(rawOutputs, session?.id ?? null),
    [rawOutputs, session?.id]
  );
  const hasAssistantEvents = conversationEvents.some((event) => event.type !== "user.message");
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
  const sessionTitle = workspace?.taskLabel ?? session?.prompt ?? "No session selected";
  const sessionDetails = [
    session ? providerLabel(session.provider) : null,
    session?.modelLabel ?? null,
    workspace?.branch ?? null
  ].filter((detail): detail is string => Boolean(detail));

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
      await onSendSessionInput(session.id, trimmedInput);
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
          <p className="eyebrow">Session</p>
          <h2>{sessionTitle}</h2>
          <div className="conversation-meta" aria-label="Session details">
            {sessionDetails.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </div>
        </div>
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
          <kbd className="kbd kbd-hint" aria-hidden="true">⌘ ↵</kbd>
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

function LaunchSurface({
  onAddProject,
  onLaunchTask,
  onProviderChange,
  project,
  provider
}: {
  onAddProject: () => void;
  onLaunchTask: (prompt: string, provider: ProviderId) => Promise<void>;
  onProviderChange: (provider: ProviderId) => void;
  project: ProjectSummary | null;
  provider: ProviderId;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider,
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
      await onLaunchTask(trimmedPrompt, provider);
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
          <div className="provider-toggle" aria-label="Provider">
            {providerOptions.map((option) => (
              <button
                aria-pressed={provider === option.id}
                className={provider === option.id ? "active" : ""}
                key={option.id}
                type="button"
                onClick={() => onProviderChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
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

function modelDefaultForProvider(provider: ProviderId) {
  return PROVIDER_MODEL_DEFAULTS[provider];
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
  if (!line.startsWith("{")) {
    return false;
  }

  try {
    const payload = JSON.parse(line) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }

    return typeof (payload as { type?: unknown }).type === "string";
  } catch {
    return false;
  }
}

function stripTerminalControls(value: string): string {
  return value
    .replace(oscSequencePattern, "")
    .replace(csiSequencePattern, "")
    .replace(escapeSequencePattern, "")
    .replace(controlCharacterPattern, "");
}

function mergeDashboardDelta(snapshot: DashboardSnapshot, delta: DashboardDelta): DashboardSnapshot {
  return {
    projects: delta.projects ? sortProjects(upsertById(snapshot.projects, delta.projects)) : snapshot.projects,
    workspaces: delta.workspaces
      ? sortByTimestamp(upsertById(snapshot.workspaces, delta.workspaces), (workspace) => workspace.lastActivityAt)
      : snapshot.workspaces,
    sessions: delta.sessions
      ? sortByTimestamp(upsertById(snapshot.sessions, delta.sessions), (session) => session.lastActivityAt)
      : snapshot.sessions,
    events: delta.events
      ? sortByTimestamp(upsertById(snapshot.events, delta.events), (event) => event.createdAt).slice(0, 50)
      : snapshot.events,
    rawOutputs: delta.rawOutputs
      ? sortByTimestamp(upsertById(snapshot.rawOutputs, delta.rawOutputs), (output) => output.createdAt).slice(0, 100)
      : snapshot.rawOutputs,
    approvals: delta.approvals
      ? sortByTimestamp(upsertById(snapshot.approvals, delta.approvals), (approval) => approval.createdAt).slice(0, 200)
      : snapshot.approvals,
    checks: delta.checks
      ? sortByTimestamp(upsertById(snapshot.checks, delta.checks), (check) => check.startedAt).slice(0, 200)
      : snapshot.checks,
    checkpoints: delta.checkpoints
      ? sortByTimestamp(upsertById(snapshot.checkpoints, delta.checkpoints), (checkpoint) => checkpoint.createdAt).slice(0, 200)
      : snapshot.checkpoints
  };
}

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of updates) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
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
