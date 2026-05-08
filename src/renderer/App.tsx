import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  Code2,
  Command,
  FileText,
  Folder,
  GitBranch,
  GitCompare,
  Layers3,
  LayoutDashboard,
  Mic,
  MoreHorizontal,
  PanelRight,
  Play,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  TerminalSquare
} from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalRequest,
  DashboardSnapshot,
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

const navItems: Array<{ mode: ViewMode; label: string; icon: typeof LayoutDashboard }> = [
  { mode: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { mode: "board", label: "Board", icon: Layers3 },
  { mode: "cockpit", label: "Cockpit", icon: TerminalSquare },
  { mode: "review", label: "Review", icon: GitCompare },
  { mode: "compare", label: "Compare", icon: GitBranch }
];

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let isMounted = true;

    const loadDashboard = window.maestro?.dashboard.load ?? (() => Promise.resolve(demoSnapshot));

    loadDashboard()
      .then((data) => {
        if (isMounted) {
          setSnapshot(data);
          setLoadState("ready");
        }
      })
      .catch(() => {
        if (isMounted) {
          setLoadState("error");
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || isTypingTarget(event.target)) {
        return;
      }

      const index = Number(event.key) - 1;
      const item = navItems[index];
      if (!item) {
        return;
      }

      event.preventDefault();
      setViewMode(item.mode);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const selectedSession = snapshot.sessions[0] ?? null;
  const selectedWorkspace = selectedSession
    ? snapshot.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId) ?? null
    : null;

  const resolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    if (!window.maestro?.approvals.resolve) {
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId ? { ...approval, status, resolvedAt: new Date().toISOString() } : approval
        )
      }));
      return;
    }

    await window.maestro.approvals.resolve({ approvalId, status });
    setSnapshot(await window.maestro.dashboard.load());
  };

  const selectPreferredAttempt = async (sessionId: string): Promise<void> => {
    if (!window.maestro?.attempts.selectPreferred) {
      setSnapshot((current) => ({
        ...current,
        sessions: current.sessions.map((session) => ({ ...session, preferred: session.id === sessionId }))
      }));
      return;
    }

    await window.maestro.attempts.selectPreferred({ sessionId });
    setSnapshot(await window.maestro.dashboard.load());
  };

  return (
    <main className="app-shell">
      <Sidebar loadState={loadState} setViewMode={setViewMode} snapshot={snapshot} viewMode={viewMode} />

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="breadcrumb">
              <Folder size={18} />
              {snapshot.projects[0]?.name ?? "maestro"} / {selectedWorkspace?.taskLabel ?? titleForView(viewMode)}
            </p>
            <h1>{titleForView(viewMode)}</h1>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" title="Run selected checks">
              <Play size={18} />
            </button>
            <button className="icon-button" type="button" title="Toggle details">
              <PanelRight size={18} />
            </button>
            <button className="icon-button" type="button" title="Archive clean workspace">
              <Archive size={18} />
            </button>
          </div>
        </header>

        <div className="work-scroll">
          {loadState === "error" ? (
            <EmptyState />
          ) : (
            <View
              approvals={snapshot.approvals}
              events={snapshot.events}
              mode={viewMode}
              onResolveApproval={resolveApproval}
              onSelectPreferredAttempt={selectPreferredAttempt}
              rawOutputs={snapshot.rawOutputs}
              selectedSession={selectedSession}
              selectedWorkspace={selectedWorkspace}
              snapshot={snapshot}
            />
          )}
        </div>

        <Composer />
      </section>

      <RightRail snapshot={snapshot} />
    </main>
  );
}

function Sidebar({
  loadState,
  setViewMode,
  snapshot,
  viewMode
}: {
  loadState: "loading" | "ready" | "error";
  setViewMode: (mode: ViewMode) => void;
  snapshot: DashboardSnapshot;
  viewMode: ViewMode;
}): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="window-controls" aria-hidden="true">
        <span className="traffic red" />
        <span className="traffic yellow" />
        <span className="traffic green" />
        <button className="small-icon" type="button" title="Search">
          <Search size={16} />
        </button>
      </div>

      <div className="mode-switch">
        <button type="button">
          <Bot size={16} />
          Chat
        </button>
        <button type="button">
          <Layers3 size={16} />
          Cowork
        </button>
        <button className="active" type="button">
          <Code2 size={16} />
          Code
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
            {snapshot.workspaces.slice(0, 7).map((workspace) => (
              <button className="session-link" key={workspace.id} type="button">
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
        <span>Example</span>
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
  onSelectPreferredAttempt: (sessionId: string) => Promise<void>;
  rawOutputs: RawProviderOutput[];
  selectedSession: SessionSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  if (mode === "board") {
    return <AgentBoard sessions={snapshot.sessions} workspaces={snapshot.workspaces} />;
  }

  if (mode === "cockpit") {
    return (
      <SessionCockpit
        approvals={approvals}
        events={events}
        onResolveApproval={onResolveApproval}
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
  const totals = useMemo(
    () => ({
      active: snapshot.sessions.filter((session) => ["running", "waiting"].includes(session.state)).length,
      review: snapshot.sessions.filter((session) => session.attention === "review-ready").length,
      blocked: snapshot.sessions.filter((session) => ["blocked", "approval-needed"].includes(session.attention)).length,
      failed: snapshot.sessions.filter((session) => session.attention === "failed").length
    }),
    [snapshot.sessions]
  );

  return (
    <div className="dashboard-grid">
      <section className="summary-band">
        <Metric label="Active" value={totals.active} tone="mint" />
        <Metric label="Review" value={totals.review} tone="gold" />
        <Metric label="Blocked" value={totals.blocked} tone="rose" />
        <Metric label="Failed" value={totals.failed} tone="blue" />
      </section>

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

function AgentBoard({ sessions, workspaces }: { sessions: SessionSummary[]; workspaces: WorkspaceSummary[] }): JSX.Element {
  return (
    <div className="lane-grid">
      <div className="board-strip">
        <strong>{sessions.length} sessions</strong>
        <span>{sessions.filter((session) => session.attention !== "normal").length} need attention</span>
      </div>
      {sessions.map((session) => {
        const workspace = workspaces.find((item) => item.id === session.workspaceId);
        return <SessionLane key={session.id} session={session} workspace={workspace ?? null} />;
      })}
    </div>
  );
}

function SessionLane({
  session,
  workspace
}: {
  session: SessionSummary;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  return (
    <article className={`lane ${session.attention}`}>
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
  rawOutputs,
  session,
  workspace
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const visibleApprovals = session ? approvals.filter((approval) => approval.sessionId === session.id) : approvals;
  const visibleEvents = session ? events.filter((event) => event.sessionId === session.id) : events;
  const visibleRawOutputs = session ? rawOutputs.filter((output) => output.sessionId === session.id) : rawOutputs;

  return (
    <div className="cockpit-grid">
      <section className="timeline-surface">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{session?.provider ?? "Provider"}</p>
            <h2>{workspace?.taskLabel ?? "No session selected"}</h2>
          </div>
          <StatusPill state={session?.attention ?? "normal"} />
        </div>
        <div className="cockpit-meta">
          <span>{session?.modelLabel ?? "No model"}</span>
          <span>{workspace?.branch ?? "No branch"}</span>
          <span>{workspace?.changedFiles ?? 0} files</span>
          <span>{workspace?.path ?? "No workspace"}</span>
        </div>
        <Timeline events={visibleEvents} />
      </section>

      <section className="terminal-surface" aria-label="Raw terminal output">
        <div className="terminal-header">
          <TerminalSquare size={18} />
          <span>{workspace?.path ?? "No workspace"}</span>
        </div>
        <pre>{terminalPreview(visibleRawOutputs)}</pre>
      </section>

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
                onClick={() => void onResolveApproval(approval.id, "rejected")}
              >
                Reject
              </button>
              <button
                disabled={approval.status !== "pending"}
                type="button"
                onClick={() => void onResolveApproval(approval.id, "approved")}
              >
                Approve
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
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
  return (
    <div className="comparison-grid">
      {snapshot.sessions.map((session) => {
        const workspace = snapshot.workspaces.find((item) => item.id === session.workspaceId);
        const check = workspace ? snapshot.checks.find((item) => item.workspaceId === workspace.id) : null;
        return (
          <article className="attempt-row" key={session.id}>
            <div>
              <span className="provider-pill">{session.provider}</span>
              <h2>{workspace?.taskLabel ?? session.prompt}</h2>
              <p>{workspace?.branch ?? "No branch"}</p>
            </div>
            <span>{workspace?.changedFiles ?? 0} files changed</span>
            <span>{check?.status ?? "No checks"}</span>
            <StatusPill state={session.attention} />
            <button className={session.preferred ? "preferred-action active" : "preferred-action"} type="button" onClick={() => void onSelectPreferredAttempt(session.id)}>
              {session.preferred ? "Preferred" : "Select"}
            </button>
          </article>
        );
      })}
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

function Composer(): JSX.Element {
  return (
    <form className="composer">
      <div className="composer-context">
        <span>
          <GitBranch size={16} />
          main
        </span>
        <span>Work locally</span>
      </div>
      <div className="composer-input">
        <input aria-label="Task prompt" placeholder="Type / for commands" />
        <button className="composer-tool" type="button" title="Add context">
          <Plus size={18} />
        </button>
        <button className="composer-tool" type="button" title="Commands">
          <Command size={18} />
        </button>
        <button className="composer-tool" type="button" title="Voice input">
          <Mic size={18} />
        </button>
        <button className="send-button" type="submit" title="Start agent">
          <ChevronRight size={20} />
        </button>
      </div>
    </form>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }): JSX.Element {
  return (
    <div className="timeline-list">
      {events.map((event) => (
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

function Metric({ label, value, tone }: { label: string; value: number; tone: string }): JSX.Element {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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

function EmptyState(): JSX.Element {
  return (
    <section className="empty-state">
      <AlertTriangle size={24} />
      <h2>Local state could not be loaded</h2>
      <p>Maestro keeps working from local storage, but the database needs attention before the dashboard can render.</p>
    </section>
  );
}

function terminalPreview(outputs: RawProviderOutput[]): string {
  return outputs
    .slice(0, 6)
    .map((output) => `[${output.createdAt}] ${output.stream}: ${output.content.trim()}`)
    .join("\n");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function titleForView(mode: ViewMode): string {
  const titles: Record<ViewMode, string> = {
    dashboard: "Project dashboard",
    board: "Parallel agent board",
    cockpit: "Session cockpit",
    review: "Review studio",
    compare: "Attempt comparison"
  };

  return titles[mode];
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
