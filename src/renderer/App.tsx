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

  const selectedSession = snapshot.sessions[0] ?? null;
  const selectedWorkspace = selectedSession
    ? snapshot.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId) ?? null
    : null;

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
  selectedSession,
  selectedWorkspace,
  snapshot
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  mode: ViewMode;
  selectedSession: SessionSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  if (mode === "board") {
    return <AgentBoard sessions={snapshot.sessions} workspaces={snapshot.workspaces} />;
  }

  if (mode === "cockpit") {
    return <SessionCockpit approvals={approvals} events={events} session={selectedSession} workspace={selectedWorkspace} />;
  }

  if (mode === "review") {
    return <ReviewStudio snapshot={snapshot} workspace={selectedWorkspace} />;
  }

  if (mode === "compare") {
    return <AttemptComparison sessions={snapshot.sessions} workspaces={snapshot.workspaces} />;
  }

  return <Dashboard snapshot={snapshot} />;
}

function Dashboard({ snapshot }: { snapshot: DashboardSnapshot }): JSX.Element {
  const project = snapshot.projects[0] ?? null;
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
        <Metric label="Needs Review" value={totals.review} tone="gold" />
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
          <dl className="project-details">
            <div>
              <dt>Repository</dt>
              <dd>{project.repoPath}</dd>
            </div>
            <div>
              <dt>Default provider</dt>
              <dd>{project.settings.defaultProvider}</dd>
            </div>
            <div>
              <dt>Checks</dt>
              <dd>{project.settings.checkCommands.join(", ")}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="activity-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Recent activity</p>
            <h2>Timeline</h2>
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
        <span className="provider-pill">{session.provider}</span>
        <StatusPill state={session.attention} />
      </div>
      <h2>{workspace?.taskLabel ?? session.prompt}</h2>
      <p>{session.prompt}</p>
      <div className="lane-meta">
        <span>
          <GitBranch size={14} /> {workspace?.branch ?? "unknown"}
        </span>
        <span>{workspace?.changedFiles ?? 0} files</span>
      </div>
    </article>
  );
}

function SessionCockpit({
  approvals,
  events,
  session,
  workspace
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
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
        <Timeline events={events} />
      </section>

      <section className="terminal-surface" aria-label="Raw terminal output">
        <div className="terminal-header">
          <TerminalSquare size={18} />
          <span>{workspace?.path ?? "No workspace"}</span>
        </div>
        <pre>{terminalPreview(events)}</pre>
      </section>

      <section className="approval-surface">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Approvals</p>
            <h2>Risk gate</h2>
          </div>
          <ShieldAlert size={20} />
        </div>
        {approvals.map((approval) => (
          <div className="approval-row" key={approval.id}>
            <strong>{approval.riskLevel}</strong>
            <code>{approval.command}</code>
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
      </section>
    </div>
  );
}

function AttemptComparison({
  sessions,
  workspaces
}: {
  sessions: SessionSummary[];
  workspaces: WorkspaceSummary[];
}): JSX.Element {
  return (
    <div className="comparison-grid">
      {sessions.map((session) => {
        const workspace = workspaces.find((item) => item.id === session.workspaceId);
        return (
          <article className="attempt-row" key={session.id}>
            <div>
              <span className="provider-pill">{session.provider}</span>
              <h2>{workspace?.taskLabel ?? session.prompt}</h2>
            </div>
            <span>{workspace?.changedFiles ?? 0} files</span>
            <StatusPill state={session.attention} />
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

function terminalPreview(events: TimelineEvent[]): string {
  return events
    .slice(0, 6)
    .map((event) => `[${event.createdAt}] ${event.type}: ${event.message}`)
    .join("\n");
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
