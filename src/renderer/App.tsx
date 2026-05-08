import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Command,
  FileText,
  Folder,
  GitBranch,
  GitCompare,
  Layers3,
  LayoutDashboard,
  Mic,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  TerminalSquare
} from "lucide-react";
import type { FormEvent, JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRequest,
  DashboardSnapshot,
  ProviderId,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../shared/types.js";
import { demoSnapshot } from "./demoSnapshot.js";

type ViewMode = "dashboard" | "board" | "cockpit" | "review" | "compare";

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

const escapeCharacter = String.fromCharCode(27);
const bellCharacter = String.fromCharCode(7);
const oscSequencePattern = new RegExp(`${escapeCharacter}\\][^${bellCharacter}]*(?:${bellCharacter}|${escapeCharacter}\\\\)`, "g");
const csiSequencePattern = new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g");
const escapeSequencePattern = new RegExp(`${escapeCharacter}[@-Z\\\\-_]`, "g");

const TERMINAL_PREVIEW_LINES = 6;
const RAW_OUTPUT_CAP = 500;

type ToastMessage = { kind: "error" | "info"; message: string };

const navItems: Array<{ mode: ViewMode; label: string; icon: typeof LayoutDashboard }> = [
  { mode: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { mode: "board", label: "Board", icon: Layers3 },
  { mode: "cockpit", label: "Cockpit", icon: TerminalSquare },
  { mode: "review", label: "Review", icon: GitCompare },
  { mode: "compare", label: "Compare", icon: GitBranch }
];

const providerOptions: Array<{ id: ProviderId; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" }
];

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerOverride, setProviderOverride] = useState<ProviderId | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.maestro);

  const dashboardLoadToken = useRef(0);
  const resolveApprovalToken = useRef(0);
  const selectPreferredToken = useRef(0);
  const appShellRef = useRef<HTMLElement | null>(null);
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  const loadDashboard = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    const loader = window.maestro?.dashboard.load ?? (() => Promise.resolve(demoSnapshot));
    try {
      const data = await loader();
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot(capRawOutputs(data));
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

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (loadState !== "ready" || !window.maestro?.dashboard.load || !hasActiveWork(snapshot)) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDashboard();
    }, 1200);

    return () => window.clearInterval(timer);
  }, [loadState, snapshot, loadDashboard]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadDashboard();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadDashboard]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) {
      return;
    }

    const handleKeyDown = (event: Event): void => {
      const keyEvent = event as KeyboardEvent;
      if ((!keyEvent.metaKey && !keyEvent.ctrlKey) || keyEvent.altKey || keyEvent.shiftKey || isTypingTarget(keyEvent.target)) {
        return;
      }

      const index = Number(keyEvent.key) - 1;
      const item = navItems[index];
      if (!item) {
        return;
      }

      keyEvent.preventDefault();
      setViewMode(item.mode);
    };

    shell.addEventListener("keydown", handleKeyDown);
    return () => shell.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Reconcile selectedSessionId against the snapshot without clobbering a
  // just-launched session while its dashboard refresh is still in flight.
  useEffect(() => {
    if (selectedSessionId) {
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

      const fallbackSession = snapshot.sessions[0] ?? null;
      setSelectedSessionId(fallbackSession?.id ?? null);
      setSelectedWorkspaceId(fallbackSession?.workspaceId ?? null);
    } else if (snapshot.sessions.length > 0) {
      setSelectedSessionId(snapshot.sessions[0].id);
      setSelectedWorkspaceId(snapshot.sessions[0].workspaceId);
    }
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
  const selectedProvider = providerOverride ?? snapshot.projects[0]?.settings.defaultProvider ?? "codex";

  const openWorkspaceChat = useCallback(
    (workspaceId: string): void => {
      const session = snapshot.sessions.find((item) => item.workspaceId === workspaceId) ?? null;
      setSelectedWorkspaceId(workspaceId);
      setSelectedSessionId(session?.id ?? null);
      setViewMode("cockpit");
    },
    [snapshot.sessions]
  );

  const handleSelectSession = useCallback(
    (sessionId: string): void => {
      setSelectedSessionId(sessionId);
      const session = snapshot.sessions.find((item) => item.id === sessionId) ?? null;
      if (session) {
        setSelectedWorkspaceId(session.workspaceId);
      }
    },
    [snapshot.sessions]
  );

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
        await loadDashboard();
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
    [snapshot, loadDashboard]
  );

  const selectPreferredAttempt = useCallback(
    async (sessionId: string): Promise<void> => {
      const token = ++selectPreferredToken.current;
      const previousSnapshot = snapshot;

      setSnapshot((current) => ({
        ...current,
        sessions: current.sessions.map((session) => ({ ...session, preferred: session.id === sessionId }))
      }));

      if (!window.maestro?.attempts.selectPreferred) {
        return;
      }

      try {
        await window.maestro.attempts.selectPreferred({ sessionId });
        if (token !== selectPreferredToken.current) {
          return;
        }
        await loadDashboard();
      } catch (error) {
        if (token !== selectPreferredToken.current) {
          return;
        }
        setSnapshot(previousSnapshot);
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not update preferred attempt."
        });
      }
    },
    [snapshot, loadDashboard]
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
      await loadDashboard();
    },
    [loadDashboard]
  );

  const launchTask = useCallback(
    async (prompt: string, provider: ProviderId): Promise<void> => {
      if (!window.maestro) {
        throw new Error("Open the Electron app window to launch local agents.");
      }

      const project = snapshot.projects[0];
      if (!project) {
        throw new Error("Register a project before launching an agent.");
      }

      const workspace = await window.maestro.workspaces.createCurrent({
        projectId: project.id,
        taskLabel: titleFromPrompt(prompt)
      });

      const launchedSession = await window.maestro.providers.launch({
        workspaceId: workspace.id,
        provider,
        prompt,
        modelLabel: modelLabelForProvider(provider, project.settings.defaultModelLabel),
        cols: 120,
        rows: 32
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      setSelectedWorkspaceId(workspace.id);
      setSelectedSessionId(launchedSession.id);
      setViewMode("cockpit");
      await loadDashboard();
    },
    [snapshot.projects, loadDashboard]
  );

  return (
    <main
      className={viewMode === "cockpit" ? "app-shell focus-mode" : "app-shell"}
      ref={appShellRef}
      tabIndex={-1}
    >
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
        onOpenWorkspaceChat={openWorkspaceChat}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        setViewMode={setViewMode}
        snapshot={snapshot}
        viewMode={viewMode}
      />

      <section className={viewMode === "cockpit" ? "workspace cockpit-workspace" : "workspace"}>
        <div className={viewMode === "cockpit" ? "work-scroll cockpit-scroll" : "work-scroll"}>
          {loadState === "error" ? (
            <EmptyState message={loadError} onRetry={() => void loadDashboard()} />
          ) : (
            <View
              approvals={snapshot.approvals}
              events={snapshot.events}
              mode={viewMode}
              onResolveApproval={resolveApproval}
              onSelectSession={handleSelectSession}
              onSendSessionInput={sendSessionInput}
              onSelectPreferredAttempt={selectPreferredAttempt}
              rawOutputs={snapshot.rawOutputs}
              selectedSession={selectedSession}
              selectedWorkspace={selectedWorkspace}
              snapshot={snapshot}
            />
          )}
        </div>

        {viewMode === "cockpit" ? null : (
          <Composer onLaunchTask={launchTask} onProviderChange={setProviderOverride} provider={selectedProvider} />
        )}
      </section>

      {viewMode === "cockpit" ? null : <RightRail snapshot={snapshot} />}
    </main>
  );
}

function Sidebar({
  loadState,
  onOpenWorkspaceChat,
  selectedWorkspaceId,
  setViewMode,
  snapshot,
  viewMode
}: {
  loadState: "loading" | "ready" | "error";
  onOpenWorkspaceChat: (workspaceId: string) => void;
  selectedWorkspaceId: string | null;
  setViewMode: (mode: ViewMode) => void;
  snapshot: DashboardSnapshot;
  viewMode: ViewMode;
}): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="window-controls">
        <button className="small-icon" type="button" title="Search">
          <Search size={16} />
        </button>
      </div>

      <nav className="nav-list" aria-label="Primary">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.mode}
              className={viewMode === item.mode ? "nav-item active" : "nav-item"}
              type="button"
              onClick={() => setViewMode(item.mode)}
              title={item.label}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="project-list">
        <p className="rail-label">Projects</p>
        {snapshot.projects.map((project) => (
          <div className="project-group" key={project.id}>
            <div className="project-name">
              <Folder size={16} />
              <span>{project.name}</span>
            </div>
            {snapshot.workspaces
              .filter((workspace) => workspace.projectId === project.id)
              .slice(0, 7)
              .map((workspace) => (
                <button
                  aria-pressed={selectedWorkspaceId === workspace.id}
                  className={selectedWorkspaceId === workspace.id ? "session-link active" : "session-link"}
                  key={workspace.id}
                  type="button"
                  onClick={() => onOpenWorkspaceChat(workspace.id)}
                >
                  <Circle size={8} />
                  <span>{workspace.taskLabel}</span>
                </button>
              ))}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <span className="avatar">AT</span>
        <span>Adam</span>
        <span>Mentimeter</span>
        <button className="small-icon" type="button" title="Settings">
          <Settings size={16} />
        </button>
        <span className="connection-state">{loadState === "ready" ? "Online" : loadState === "loading" ? "Loading" : "Issue"}</span>
      </div>
    </aside>
  );
}

function View({
  approvals,
  events,
  mode,
  onResolveApproval,
  onSelectSession,
  onSendSessionInput,
  onSelectPreferredAttempt,
  rawOutputs,
  selectedSession,
  selectedWorkspace,
  snapshot
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  mode: ViewMode;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSelectSession: (sessionId: string) => void;
  onSendSessionInput: (sessionId: string, input: string) => Promise<void>;
  onSelectPreferredAttempt: (sessionId: string) => Promise<void>;
  rawOutputs: RawProviderOutput[];
  selectedSession: SessionSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  if (mode === "board") {
    return (
      <AgentBoard
        onSelectSession={onSelectSession}
        selectedSessionId={selectedSession?.id ?? null}
        sessions={snapshot.sessions}
        workspaces={snapshot.workspaces}
      />
    );
  }

  if (mode === "cockpit") {
    return (
      <SessionCockpit
        approvals={approvals}
        events={events}
        onResolveApproval={onResolveApproval}
        onSendSessionInput={onSendSessionInput}
        rawOutputs={rawOutputs}
        session={selectedSession}
        workspace={selectedWorkspace}
      />
    );
  }

  if (mode === "review") {
    return <ReviewStudio snapshot={snapshot} workspace={selectedWorkspace} />;
  }

  if (mode === "compare") {
    return <AttemptComparison onSelectPreferredAttempt={onSelectPreferredAttempt} snapshot={snapshot} />;
  }

  return <Dashboard snapshot={snapshot} />;
}

function Dashboard({ snapshot }: { snapshot: DashboardSnapshot }): JSX.Element {
  const project = snapshot.projects[0] ?? null;
  const activeWorkspaces = snapshot.workspaces.filter((workspace) =>
    ["created", "running", "waiting", "blocked"].includes(workspace.state)
  );

  return (
    <div className="dashboard-grid">
      <section className="project-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Registered project</p>
            <h2>{project?.name ?? "No project registered"}</h2>
          </div>
          <ChevronRight size={20} />
        </div>
        {project ? (
          <>
            <div className="project-strip">
              <span>{project.repoPath}</span>
              <span>{project.settings.defaultProvider}</span>
            </div>
            <div className="workspace-list">
              {activeWorkspaces.slice(0, 5).map((workspace) => (
                <div className="workspace-row" key={workspace.id}>
                  <div>
                    <strong>{workspace.taskLabel}</strong>
                    <span>{workspace.branch}</span>
                  </div>
                  <span>{workspace.changedFiles} files</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="activity-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Recent activity</p>
            <h2>Recent</h2>
          </div>
          <Activity size={20} />
        </div>
        <Timeline events={snapshot.events} />
      </section>
    </div>
  );
}

function AgentBoard({
  onSelectSession,
  selectedSessionId,
  sessions,
  workspaces
}: {
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
  sessions: SessionSummary[];
  workspaces: WorkspaceSummary[];
}): JSX.Element {
  return (
    <div className="lane-grid">
      <div className="board-strip">
        <strong>{sessions.length} sessions</strong>
        <span>{sessions.filter((session) => session.attention !== "normal").length} need attention</span>
      </div>
      {sessions.map((session) => {
        const workspace = workspaces.find((item) => item.id === session.workspaceId);
        return (
          <SessionLane
            key={session.id}
            isSelected={session.id === selectedSessionId}
            onSelect={() => onSelectSession(session.id)}
            session={session}
            workspace={workspace ?? null}
          />
        );
      })}
    </div>
  );
}

function SessionLane({
  isSelected,
  onSelect,
  session,
  workspace
}: {
  isSelected: boolean;
  onSelect: () => void;
  session: SessionSummary;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  return (
    <article
      aria-pressed={isSelected}
      className={`lane ${session.attention}${isSelected ? " selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="lane-topline">
        <span className={`attention-dot ${session.attention}`} />
        <span className="provider-pill">{session.provider}</span>
        <StatusPill state={session.attention} />
      </div>
      <h2>{workspace?.taskLabel ?? session.prompt}</h2>
      <div className="lane-meta">
        <span>
          <GitBranch size={14} /> {workspace?.branch ?? "unknown"}
        </span>
        <span>{workspace?.changedFiles ?? 0} files</span>
        <span>{formatTime(session.lastActivityAt)}</span>
      </div>
    </article>
  );
}

function SessionCockpit({
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
  const visibleRawOutputs = useMemo(
    () => (sessionId ? rawOutputs.filter((output) => output.sessionId === sessionId) : rawOutputs),
    [rawOutputs, sessionId]
  );

  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    try {
      await onResolveApproval(approvalId, status);
    } catch {
      // Errors are surfaced through the parent toast system.
    }
  };

  return (
    <div className="cockpit-grid">
      <SessionConversation
        events={visibleEvents}
        onSendSessionInput={onSendSessionInput}
        rawOutputs={visibleRawOutputs}
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
          <div className="approval-row" key={approval.id}>
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
  const conversationEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .slice()
        .reverse(),
    [events]
  );
  const canSend = Boolean(session && ["complete", "waiting"].includes(session.state));

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending) {
      return;
    }

    setIsSending(true);
    setStatus(null);
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
          <p className="eyebrow">Conversation</p>
          <h2>{session ? "Live prompt" : "No live session"}</h2>
        </div>
        <StatusPill state={session?.attention ?? "normal"} />
      </div>
      <div className="conversation-meta">
        <span>{session?.provider ?? "provider"}</span>
        <span>{session?.modelLabel ?? "model"}</span>
        <span>{workspace?.branch ?? "branch"}</span>
        <span>{session?.state ?? "idle"}</span>
      </div>
      <div className="conversation-list">
        {conversationEvents.length > 0 ? (
          conversationEvents.map((event) => (
            <article className={event.type === "user.message" ? "chat-bubble user" : "chat-bubble assistant"} key={event.id}>
              <p>{event.message}</p>
            </article>
          ))
        ) : (
          <p className="conversation-empty">Agent replies will appear here.</p>
        )}
      </div>
      <form className="session-input" onSubmit={(event) => void submitInput(event)}>
        <input
          aria-label="Session prompt"
          disabled={!canSend || isSending}
          onChange={(event) => setInput(event.target.value)}
          placeholder={session?.state === "running" ? "Waiting for agent" : canSend ? "Send a follow-up" : "Session is not accepting input"}
          value={input}
        />
        <button disabled={!canSend || isSending || !input.trim()} type="submit" title="Send follow-up">
          <ChevronRight size={18} />
        </button>
      </form>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
      {rawOutputs.length > 0 ? (
        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <pre>{terminalPreview(rawOutputs)}</pre>
        </details>
      ) : null}
    </section>
  );
}

function ReviewStudio({
  snapshot,
  workspace
}: {
  snapshot: DashboardSnapshot;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const check = snapshot.checks[0] ?? null;
  return (
    <div className="review-grid">
      <section className="file-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Changed files</p>
            <h2>{workspace?.changedFiles ?? 0} touched</h2>
          </div>
          <GitBranch size={20} />
        </div>
        {["src/renderer/App.tsx", "src/main/ipc.ts", "src/main/persistence/database.ts"].map((file) => (
          <button className="file-row" key={file} type="button">
            <span>{file}</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </section>

      <section className="diff-surface">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Diff preview</p>
            <h2>{workspace?.branch ?? "No branch"}</h2>
          </div>
          <GitCompare size={20} />
        </div>
        <pre>{`+ normalized event stream
+ append-only local storage
+ review-ready attention state`}</pre>
      </section>

      <section className="checks-surface">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Checks</p>
            <h2>{check?.status ?? "Not run"}</h2>
          </div>
          <CheckCircle2 size={20} />
        </div>
        <p>{check?.summary ?? "Configured checks will stream here."}</p>
        <div className="review-actions">
          <button type="button">Checkpoint</button>
          <button type="button">Keep</button>
          <button type="button">Archive</button>
        </div>
      </section>
    </div>
  );
}

function AttemptComparison({
  onSelectPreferredAttempt,
  snapshot
}: {
  onSelectPreferredAttempt: (sessionId: string) => Promise<void>;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  // Group sessions by task label (workspace family); only show groups with siblings.
  const groups = useMemo(() => {
    const byKey = new Map<string, SessionSummary[]>();
    for (const session of snapshot.sessions) {
      const workspace = snapshot.workspaces.find((item) => item.id === session.workspaceId);
      const key = workspace?.taskLabel ?? "ungrouped";
      const list = byKey.get(key);
      if (list) {
        list.push(session);
      } else {
        byKey.set(key, [session]);
      }
    }
    return Array.from(byKey.entries()).filter(([, sessions]) => sessions.length > 1);
  }, [snapshot.sessions, snapshot.workspaces]);

  const handleSelect = async (sessionId: string): Promise<void> => {
    try {
      await onSelectPreferredAttempt(sessionId);
    } catch {
      // Errors surface via the parent's toast system.
    }
  };

  if (groups.length === 0) {
    return (
      <div className="comparison-grid">
        <p className="comparison-empty">Multiple attempts for the same task will appear here.</p>
      </div>
    );
  }

  return (
    <div className="comparison-grid">
      {groups.map(([groupKey, groupSessions]) => (
        <section className="comparison-group" key={groupKey}>
          <header className="comparison-group-heading">
            <p className="eyebrow">Task</p>
            <h2>{groupKey}</h2>
          </header>
          {groupSessions.map((session) => {
            const workspace = snapshot.workspaces.find((item) => item.id === session.workspaceId);
            const check = workspace ? snapshot.checks.find((item) => item.workspaceId === workspace.id) : null;
            return (
              <article className="attempt-row" key={session.id}>
                <div>
                  <span className="provider-pill">{session.provider}</span>
                  <h3>{workspace?.taskLabel ?? session.prompt}</h3>
                  <p>{workspace?.branch ?? "No branch"}</p>
                </div>
                <span>{workspace?.changedFiles ?? 0} files changed</span>
                <span>{check?.status ?? "No checks"}</span>
                <StatusPill state={session.attention} />
                <button
                  className={session.preferred ? "preferred-action active" : "preferred-action"}
                  type="button"
                  onClick={() => {
                    void handleSelect(session.id);
                  }}
                >
                  {session.preferred ? "Preferred" : "Select"}
                </button>
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function RightRail({ snapshot }: { snapshot: DashboardSnapshot }): JSX.Element {
  const completed = snapshot.sessions.filter((session) => session.state === "complete").length;
  const active = snapshot.sessions.filter((session) => ["running", "waiting"].includes(session.state)).length;
  const project = snapshot.projects[0] ?? null;

  return (
    <aside className="right-rail">
      <section className="rail-card">
        <div className="rail-heading">
          <p className="rail-label">Progress</p>
          <MoreHorizontal size={18} />
        </div>
        <div className="progress-list">
          {[
            "Register local projects",
            "Create isolated worktrees",
            "Discover Claude and Codex",
            "Run validation"
          ].map((item) => (
            <div className="progress-item" key={item}>
              <CheckCircle2 size={16} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rail-card">
        <p className="rail-label">Branch details</p>
        <button className="rail-action" type="button">
          <GitCompare size={17} />
          Changes
        </button>
        <button className="rail-action" type="button">
          <GitBranch size={17} />
          Git actions
        </button>
        <button className="rail-action muted" type="button">
          <ShieldAlert size={17} />
          Pull request unavailable
        </button>
      </section>

      <section className="rail-card">
        <p className="rail-label">Artifacts</p>
        <button className="rail-action" type="button">
          <FileText size={17} />
          tasks.md
        </button>
        <button className="rail-action" type="button">
          <FileText size={17} />
          design.md
        </button>
      </section>

      <section className="rail-card">
        <p className="rail-label">Local state</p>
        <dl className="rail-stats">
          <div>
            <dt>Active</dt>
            <dd>{active}</dd>
          </div>
          <div>
            <dt>Complete</dt>
            <dd>{completed}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{project?.settings.defaultProvider ?? "codex"}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

function Composer({
  onLaunchTask,
  onProviderChange,
  provider
}: {
  onLaunchTask: (prompt: string, provider: ProviderId) => Promise<void>;
  onProviderChange: (provider: ProviderId) => void;
  provider: ProviderId;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  return (
    <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
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
      <div className="composer-input">
        <input
          aria-label="Task prompt"
          disabled={isSubmitting}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask an agent to work locally"
          value={prompt}
        />
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
          <ChevronRight size={20} />
        </button>
      </div>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
    </form>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }): JSX.Element {
  const visibleEvents = events.filter((event) => isVisibleTimelineEvent(event));

  return (
    <div className="timeline-list">
      {visibleEvents.map((event) => (
        <article className="timeline-item" key={event.id}>
          <span className="event-dot" />
          <div>
            <strong>{event.type}</strong>
            <p>{event.message}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function StatusPill({ state }: { state: SessionSummary["attention"] }): JSX.Element {
  const icon = state === "failed" || state === "blocked" ? <AlertTriangle size={14} /> : <Activity size={14} />;
  return (
    <span className={`status-pill ${state}`}>
      {icon}
      {state}
    </span>
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

function terminalPreview(outputs: RawProviderOutput[]): string {
  return outputs
    .slice(-TERMINAL_PREVIEW_LINES)
    .map((output) => `[${output.createdAt}] ${output.stream}: ${stripTerminalControls(output.content).trim()}`)
    .filter((line) => !line.endsWith(":"))
    .join("\n");
}

function capRawOutputs(snapshot: DashboardSnapshot): DashboardSnapshot {
  if (snapshot.rawOutputs.length <= RAW_OUTPUT_CAP) {
    return snapshot;
  }
  return {
    ...snapshot,
    rawOutputs: snapshot.rawOutputs.slice(-RAW_OUTPUT_CAP)
  };
}

function stripTerminalControls(value: string): string {
  return value
    .replace(oscSequencePattern, "")
    .replace(csiSequencePattern, "")
    .replace(escapeSequencePattern, "")
    .replaceAll(/./gs, (character) => (isDisplayControlCharacter(character) ? "" : character));
}

function isDisplayControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Local agent task";
}

function modelLabelForProvider(provider: ProviderId, defaultModelLabel: string): string {
  return provider === "claude" ? "Claude Code" : defaultModelLabel;
}

function isBrowserPreview(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}

function hasActiveWork(snapshot: DashboardSnapshot): boolean {
  return (
    snapshot.sessions.some((session) => ["running", "waiting"].includes(session.state)) ||
    snapshot.checks.some((check) => ["queued", "running"].includes(check.status))
  );
}

function isVisibleTimelineEvent(event: TimelineEvent): boolean {
  return (
    event.payload.raw !== true &&
    event.message !== "turn.completed" &&
    ["user.message", "message.delta", "message.completed", "error"].includes(event.type)
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target.getAttribute("role") === "textbox") return true;
  // jsdom does not always implement `isContentEditable`, so also walk the ancestor
  // chain checking for `contenteditable="true"` (or empty string, which means true).
  if (target.isContentEditable) return true;
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const value = node.getAttribute?.("contenteditable");
    if (value === "" || value === "true") return true;
  }
  return false;
}
