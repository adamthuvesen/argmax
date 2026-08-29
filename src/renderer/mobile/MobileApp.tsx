import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { ChevronLeft, FolderGit2, Moon, Plus, Sun } from "lucide-react";
import { SCRATCH_PROJECT_ID, type SessionSummary, type WorkspaceSummary } from "../../shared/types.js";
import { SessionPane } from "../components/SessionPane.js";
import { MobileReviewScreen } from "./MobileReviewScreen.js";
import { NewSessionScreen } from "./NewSessionScreen.js";
import { useDashboardSession } from "../hooks/useDashboardSession.js";
import { usePriorityDemotion } from "../hooks/usePriorityDemotion.js";
import { useSessionCommands } from "../hooks/useSessionCommands.js";
import { loadDashboardSnapshot } from "../lib/loadDashboardSnapshot.js";
import { computePriorityEntries, type PriorityAttention } from "../lib/priority.js";
import {
  applyThemeToDocument,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type ResolvedTheme
} from "../lib/theme.js";
import type { ToastMessage } from "../lib/withToast.js";
import {
  REMOTE_CONNECTION_LOST_MESSAGE,
  subscribeRemoteConnection,
  type RemoteConnectionState
} from "../lib/wsTransport.js";

const ATTENTION_LABEL: Record<PriorityAttention, string> = {
  "approval-needed": "needs approval",
  blocked: "waiting on you",
  failed: "failed",
  "review-ready": "review ready"
};

interface SessionListRow {
  workspace: WorkspaceSummary;
  session: SessionSummary | null;
  attention: PriorityAttention | null;
}

/** Compact age for list rows: "now", "5m", "2h", "3d". */
function relativeAge(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.floor((nowMs - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function MobileSessionRow({
  row,
  projectName,
  nowMs,
  onOpen
}: {
  row: SessionListRow;
  projectName: string | null;
  nowMs: number;
  onOpen: (workspaceId: string) => void;
}): JSX.Element {
  const { workspace, session, attention } = row;
  const running = workspace.state === "running";
  const age = relativeAge(session?.lastActivityAt ?? workspace.lastActivityAt, nowMs);
  return (
    <li>
      <button
        type="button"
        className="mobile-session-row"
        data-attention={attention ?? undefined}
        data-running={running || undefined}
        onClick={() => onOpen(workspace.id)}
      >
        <span className="mobile-session-text">
          <span className="mobile-session-title-line">
            {running ? <span className="mobile-session-live" aria-label="running" /> : null}
            <span className="mobile-session-title">{workspace.taskLabel}</span>
          </span>
          <span className="mobile-session-subtitle">
            {attention ? (
              <span className="mobile-session-chip" data-attention={attention}>
                {ATTENTION_LABEL[attention]}
              </span>
            ) : null}
            {projectName ? <span className="mobile-session-project">{projectName}</span> : null}
          </span>
        </span>
        {age ? <span className="mobile-session-age">{age}</span> : null}
      </button>
    </li>
  );
}

function SessionSection({
  label,
  rows,
  projectNamesById,
  nowMs,
  onOpen
}: {
  label: string;
  rows: SessionListRow[];
  projectNamesById: Map<string, string>;
  nowMs: number;
  onOpen: (workspaceId: string) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="mobile-section" aria-label={label}>
      <h2 className="mobile-section-label">{label}</h2>
      <ul className="mobile-session-list">
        {rows.map((row) => (
          <MobileSessionRow
            key={row.workspace.id}
            row={row}
            projectName={projectNamesById.get(row.workspace.projectId) ?? null}
            nowMs={nowMs}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

export function MobileApp(): JSX.Element {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Backgrounding the phone kills the socket on every app switch, so requests
  // caught mid-flight fail with the connection-lost message as a matter of
  // routine. The "Reconnecting…" banner is the honest signal; the toast is not.
  const showToast = useCallback((next: ToastMessage) => {
    if (next.kind === "error" && next.message === REMOTE_CONNECTION_LOST_MESSAGE) return;
    setToast(next);
  }, []);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()));
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      writeStoredTheme(next);
      return next;
    });
  }, []);

  const {
    snapshot,
    loadState,
    loadError,
    selectedSessionId,
    selectedSession,
    selectedWorkspace,
    selectedWorkspaceId,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    selectedProject,
    refresh,
    loadSessionEvents,
    openWorkspaceChat,
    resolveApproval
  } = useDashboardSession(loadDashboardSnapshot, { onErrorToast: (message) => showToast({ kind: "error", message }) });

  const commands = useSessionCommands({
    refreshDashboardStatus: refresh,
    loadSessionEvents,
    setToast: showToast,
    fastMode: false
  });

  // Same read-clears-attention rule as the desktop sidebar: opening a session
  // and going back to the list dismisses its chip; running sessions keep it.
  usePriorityDemotion({
    selectedWorkspaceId,
    isSettingsOpen: false,
    isFullLauncherOpen: false,
    workspaces: snapshot.workspaces,
    sessions: snapshot.sessions,
    onDemote: (workspaceId) => {
      void window.argmax?.workspaces
        .setPriorityDismissed({ workspaceId, dismissed: true })
        .then(() => refresh())
        .catch(() => undefined);
    }
  });

  const [connection, setConnection] = useState<RemoteConnectionState>({
    status: "connected",
    resync: false
  });
  useEffect(() => subscribeRemoteConnection(setConnection), []);
  // A socket that died and came back missed every delta in between, so the
  // snapshot has to be reloaded rather than resumed.
  useEffect(() => {
    if (connection.status === "connected" && connection.resync) void refresh();
  }, [connection, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // One shared clock per render pass; refreshed each minute so row ages don't
  // freeze while the list sits open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const projectNamesById = useMemo(
    () => new Map(snapshot.projects.map((project) => [project.id, project.name])),
    [snapshot.projects]
  );

  // One flat list, newest activity first, pinned floated on top. Attention
  // still marks rows with a chip; it just doesn't reorder them.
  const { pinnedRows, activityRows } = useMemo(() => {
    const sessionsByWorkspace = new Map(snapshot.sessions.map((session) => [session.workspaceId, session]));
    const attentionByWorkspace = new Map(
      computePriorityEntries(snapshot.workspaces, snapshot.sessions, nowMs).map((entry) => [
        entry.workspace.id,
        entry.attention
      ])
    );
    const rows: SessionListRow[] = snapshot.workspaces
      .filter((workspace) => workspace.state !== "archived" && workspace.kind !== "popup")
      .map((workspace) => ({
        workspace,
        session: sessionsByWorkspace.get(workspace.id) ?? null,
        attention: attentionByWorkspace.get(workspace.id) ?? null
      }));
    const activityOf = (row: SessionListRow): string =>
      row.session?.lastActivityAt ?? row.workspace.lastActivityAt ?? "";
    rows.sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
    return {
      pinnedRows: rows.filter((row) => row.workspace.pinned),
      activityRows: rows.filter((row) => !row.workspace.pinned)
    };
  }, [nowMs, snapshot.sessions, snapshot.workspaces]);

  // Full-screen Changes/Files view for the open session.
  const [reviewOpen, setReviewOpen] = useState(false);

  const closeSession = useCallback(() => {
    setReviewOpen(false);
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [setSelectedSessionId, setSelectedWorkspaceId]);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const handleLaunched = useCallback(
    async (workspaceId: string): Promise<void> => {
      // The snapshot predates the new workspace; refresh before opening it so
      // openWorkspaceChat can resolve the row.
      await refresh();
      setNewSessionOpen(false);
      openWorkspaceChat(workspaceId);
    },
    [openWorkspaceChat, refresh]
  );

  const sessionOpen = selectedWorkspaceId !== null && (selectedSession !== null || selectedSessionId !== null);
  const empty = pinnedRows.length === 0 && activityRows.length === 0;
  // Slim enough to sit under either header without displacing the screen it
  // belongs to; the list and the conversation stay usable while it shows.
  const connectionBanner =
    connection.status === "connected" ? null : (
      <div className="mobile-connection-banner" role="status" aria-label="Reconnecting">
        Reconnecting…
      </div>
    );

  return (
    <div
      className="mobile-shell"
      data-screen={sessionOpen ? "session" : newSessionOpen ? "new" : "list"}
    >
      {!sessionOpen && newSessionOpen ? (
        <NewSessionScreen
          projects={snapshot.projects.filter((project) => project.id !== SCRATCH_PROJECT_ID)}
          onClose={() => setNewSessionOpen(false)}
          onLaunched={handleLaunched}
          onError={(message) => showToast({ kind: "error", message })}
        />
      ) : sessionOpen && reviewOpen && selectedWorkspace ? (
        <MobileReviewScreen workspace={selectedWorkspace} onClose={() => setReviewOpen(false)} />
      ) : sessionOpen ? (
        <div className="mobile-session-screen">
          <header className="mobile-session-header">
            <button type="button" className="mobile-back" onClick={closeSession} aria-label="Back to sessions">
              <ChevronLeft size={22} aria-hidden />
            </button>
            <span className="mobile-session-header-title">{selectedWorkspace?.taskLabel ?? ""}</span>
            {selectedWorkspace ? (
              <button
                type="button"
                className="mobile-icon-button"
                onClick={() => setReviewOpen(true)}
                aria-label={
                  selectedWorkspace.changedFiles > 0
                    ? `Files and changes, ${selectedWorkspace.changedFiles} changed`
                    : "Files and changes"
                }
              >
                <FolderGit2 size={18} aria-hidden />
                {selectedWorkspace.changedFiles > 0 ? (
                  <span className="mobile-header-badge" aria-hidden>
                    {selectedWorkspace.changedFiles}
                  </span>
                ) : null}
              </button>
            ) : (
              <span className="mobile-header-spacer" aria-hidden />
            )}
          </header>
          {connectionBanner}
          <SessionPane
            approvals={snapshot.approvals}
            checks={snapshot.checks}
            events={snapshot.events}
            rawOutputs={snapshot.rawOutputs}
            pendingMessages={snapshot.pendingMessages}
            session={selectedSession}
            workspace={selectedWorkspace}
            project={selectedProject}
            onLoadSessionEvents={loadSessionEvents}
            onResolveApproval={resolveApproval}
            onSendSessionInput={commands.sendSessionInput}
            onCancelQueuedMessage={commands.cancelQueuedMessage}
            onSendQueuedMessageNow={commands.sendQueuedMessageNow}
            onTerminateSession={commands.terminateSession}
            showCostPanel={false}
            workspaceCardVisible={false}
          />
        </div>
      ) : (
        <div className="mobile-list-screen">
          <header className="mobile-list-header">
            <h1>Argmax</h1>
            <button
              type="button"
              className="mobile-icon-button"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              onClick={() => setNewSessionOpen(true)}
              aria-label="New session"
            >
              <Plus size={19} aria-hidden />
            </button>
          </header>
          {connectionBanner}
          <div className="mobile-list-scroll">
            {loadState === "error" ? (
              <div className="mobile-empty" role="alert">
                <p>Could not reach Argmax.</p>
                {loadError ? <p className="mobile-empty-detail">{loadError}</p> : null}
                <button type="button" className="mobile-retry" onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            ) : empty ? (
              <div className="mobile-empty">
                <p>{loadState === "loading" ? "Connecting…" : "No active sessions."}</p>
              </div>
            ) : (
              <>
                <SessionSection
                  label="Pinned"
                  rows={pinnedRows}
                  projectNamesById={projectNamesById}
                  nowMs={nowMs}
                  onOpen={openWorkspaceChat}
                />
                <SessionSection
                  label={pinnedRows.length > 0 ? "Sessions" : "All sessions"}
                  rows={activityRows}
                  projectNamesById={projectNamesById}
                  nowMs={nowMs}
                  onOpen={openWorkspaceChat}
                />
              </>
            )}
          </div>
        </div>
      )}
      {toast ? (
        <div className={`mobile-toast mobile-toast-${toast.kind}`} role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
