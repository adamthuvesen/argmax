import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Archive, FolderGit2, Moon, MoreHorizontal, Plus, Sun } from "lucide-react";
import { SCRATCH_PROJECT_ID, type SessionSummary, type WorkspaceSummary } from "../../shared/types.js";
import { LinesSkeleton } from "../components/LinesSkeleton.js";
import { SessionPane } from "../components/SessionPane.js";
import { BottomSheet, SheetOption } from "./BottomSheet.js";
import { takeDeepLinkSessionId } from "./deepLink.js";
import { MobileScreenHeader } from "./MobileScreenHeader.js";
import { NewSessionScreen, type PickerKind } from "./NewSessionScreen.js";
import { useMobileBackNavigation } from "./useMobileBackNavigation.js";
import { useVisualViewportInsets } from "./useVisualViewportInsets.js";
import { useDashboardSession } from "../hooks/useDashboardSession.js";
import { useSessionCommands } from "../hooks/useSessionCommands.js";
import { importChunk } from "../lib/importChunk.js";
import { loadDashboardSnapshot } from "../lib/loadDashboardSnapshot.js";
import { computeWorkspaceAttention, type PriorityAttention } from "../lib/priority.js";
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

// The review screen drags in the file tree, the diff renderer and the
// CodeMirror preview — ~1.36 MB the phone would otherwise pull over the tailnet
// on every cold load for a screen reached only from the session header. Lazy
// like the desktop's ReviewPanel (SessionPane.tsx), so mobile.html stops
// preloading that chunk.
// Through importChunk because a phone keeps a page alive across renderer
// rebuilds, and the chunk hash it holds stops existing the moment one lands.
const MobileReviewScreen = lazy(() =>
  importChunk(async () => ({
    default: (await import("./MobileReviewScreen.js")).MobileReviewScreen
  }))
);

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
  onOpen,
  onOpenActions
}: {
  row: SessionListRow;
  projectName: string | null;
  nowMs: number;
  onOpen: (workspaceId: string) => void;
  onOpenActions: (row: SessionListRow) => void;
}): JSX.Element {
  const { workspace, session, attention } = row;
  const running = workspace.state === "running";
  const age = relativeAge(session?.lastActivityAt ?? workspace.lastActivityAt, nowMs);
  return (
    // The actions button is a sibling of the open button, not nested inside
    // it: a button within a button is invalid and swallows the inner tap.
    <li className="mobile-session-item">
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
      {/* Named without the task label so it doesn't shadow the row button
          under a name query; the row's own text precedes it for a reader. */}
      <button
        type="button"
        className="mobile-session-more"
        aria-label="Session actions"
        title={workspace.taskLabel}
        aria-haspopup="dialog"
        onClick={() => onOpenActions(row)}
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
    </li>
  );
}

function SessionSection({
  label,
  rows,
  projectNamesById,
  nowMs,
  onOpen,
  onOpenActions
}: {
  label: string;
  rows: SessionListRow[];
  projectNamesById: Map<string, string>;
  nowMs: number;
  onOpen: (workspaceId: string) => void;
  onOpenActions: (row: SessionListRow) => void;
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
            onOpenActions={onOpenActions}
          />
        ))}
      </ul>
    </section>
  );
}

export function MobileApp(): JSX.Element {
  useVisualViewportInsets();
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

  // A push notification links to one session: `mobile.html?session=<id>`. The
  // id is read once at mount — before any snapshot exists — and cashed in as
  // soon as the session shows up, so tapping a push lands on the transcript
  // that raised it instead of the list.
  const [pendingDeepLink, setPendingDeepLink] = useState(takeDeepLinkSessionId);
  useEffect(() => {
    if (!pendingDeepLink) return;
    const linked = snapshot.sessions.find((session) => session.id === pendingDeepLink);
    // Keep waiting while the first snapshot is still loading; a session that
    // never arrives (archived, wrong host) simply leaves the reader on the list.
    if (!linked) {
      if (loadState === "loading") return;
      setPendingDeepLink(null);
      return;
    }
    setPendingDeepLink(null);
    openWorkspaceChat(linked.workspaceId);
  }, [loadState, openWorkspaceChat, pendingDeepLink, snapshot.sessions]);

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
    const attentionByWorkspace = computeWorkspaceAttention(snapshot.workspaces, snapshot.sessions, nowMs);
    const rows: SessionListRow[] = snapshot.workspaces
      .filter((workspace) => workspace.state !== "archived" && workspace.kind !== "popup")
      .map((workspace) => ({
        workspace,
        session: sessionsByWorkspace.get(workspace.id) ?? null,
        attention: attentionByWorkspace.get(workspace.id)?.attention ?? null
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
  // Set when a file reference in the transcript was tapped, so the review
  // screen lands on that file instead of the tree root.
  const [reviewFilePath, setReviewFilePath] = useState<string | null>(null);
  // The review screen's Files drill-down (tree → file) is a screen of its own
  // for a back gesture, so its open state lives here rather than inside it.
  const [reviewFilePreviewOpen, setReviewFilePreviewOpen] = useState(false);

  const closeReview = useCallback(() => {
    setReviewOpen(false);
    setReviewFilePreviewOpen(false);
  }, []);

  const closeSession = useCallback(() => {
    closeReview();
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [closeReview, setSelectedSessionId, setSelectedWorkspaceId]);

  // Same dirty-worktree rules as the desktop sidebar: confirm before a
  // destructive force-archive, and re-prompt once when the backend's fresh
  // status check finds changes the cached snapshot missed ("kept" result).
  const archiveWorkspace = useCallback(
    async (workspace: WorkspaceSummary): Promise<void> => {
      if (!window.argmax) return;
      const confirmDiscard = (taskLabel: string, changedFiles: number): boolean => {
        const fileLabel = changedFiles === 1 ? "1 uncommitted change" : `${changedFiles} uncommitted changes`;
        return window.confirm(
          `${taskLabel} has ${fileLabel}. Archiving will delete the worktree and discard these changes (the branch is preserved). Continue?`
        );
      };
      let force = false;
      if (workspace.dirty && !workspace.sharedWorkspace) {
        if (!confirmDiscard(workspace.taskLabel, workspace.changedFiles)) return;
        force = true;
      }
      try {
        let result = await window.argmax.workspaces.archive({ workspaceId: workspace.id, force });
        if (result.state === "kept" && !force && !result.sharedWorkspace) {
          if (!confirmDiscard(result.taskLabel, result.changedFiles)) return;
          result = await window.argmax.workspaces.archive({ workspaceId: workspace.id, force: true });
        }
        if (result.state !== "archived") {
          showToast({
            kind: "info",
            message: "Workspace has uncommitted changes — kept. Commit or discard, then retry archive."
          });
        } else {
          closeSession();
        }
      } catch (error) {
        showToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Workspace archive failed."
        });
      }
      await refresh();
    },
    [closeSession, refresh, showToast]
  );

  // Same fork flow as the desktop grid: new workspace, copied transcript,
  // diverging provider conversation. Refresh first so openWorkspaceChat can
  // resolve the forked row, then jump straight into it.
  const forkSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!window.argmax) return;
      try {
        const forked = await window.argmax.session.fork({ sessionId });
        await refresh();
        openWorkspaceChat(forked.workspace.id);
      } catch (error) {
        showToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't fork the session."
        });
      }
    },
    [openWorkspaceChat, refresh, showToast]
  );

  const [actionsRow, setActionsRow] = useState<SessionListRow | null>(null);

  const setPinned = useCallback(
    async (workspace: WorkspaceSummary): Promise<void> => {
      if (!window.argmax) return;
      try {
        await window.argmax.workspaces.setPinned({
          workspaceId: workspace.id,
          pinned: !workspace.pinned
        });
      } catch (error) {
        showToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't change the pin."
        });
      }
      await refresh();
    },
    [refresh, showToast]
  );

  const renameWorkspace = useCallback(
    async (workspace: WorkspaceSummary): Promise<void> => {
      if (!window.argmax) return;
      const nextLabel = window.prompt("Session name", workspace.taskLabel)?.trim();
      if (!nextLabel || nextLabel === workspace.taskLabel) return;
      try {
        await window.argmax.workspaces.setLabel({ workspaceId: workspace.id, taskLabel: nextLabel });
      } catch (error) {
        showToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't rename the session."
        });
      }
      await refresh();
    },
    [refresh, showToast]
  );

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // New-session picker state lives here, not inside that screen, so a back
  // gesture can dismiss a picker without discarding the typed prompt.
  const [newSessionSheet, setNewSessionSheet] = useState<PickerKind | null>(null);
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
  // Mirrors the render below: the review screen needs a workspace to draw, and
  // a workspace that drops out of the snapshot must take its history entry
  // with it, or one back press changes nothing on screen.
  const reviewShown = sessionOpen && reviewOpen && selectedWorkspace !== null;
  // A sheet is a screen as far as a back gesture is concerned: without this,
  // back on the list screen leaves the app with the sheet still up, and back
  // on the New session screen tears the screen down under an open picker.
  const sheetOpen = actionsRow !== null || newSessionSheet !== null;

  const filePreviewShown = reviewShown && reviewFilePreviewOpen;

  // Screen depth for the hardware back button: list → session/new → review →
  // file preview, plus one for an open sheet.
  const screenDepth =
    (sessionOpen ? (reviewShown ? (filePreviewShown ? 3 : 2) : 1) : newSessionOpen ? 1 : 0) +
    (sheetOpen ? 1 : 0);
  const goBackOneScreen = useCallback((): void => {
    if (actionsRow !== null) {
      setActionsRow(null);
      return;
    }
    if (newSessionSheet !== null) {
      setNewSessionSheet(null);
      return;
    }
    if (filePreviewShown) {
      setReviewFilePreviewOpen(false);
      return;
    }
    if (reviewShown) {
      closeReview();
      return;
    }
    if (newSessionOpen && !sessionOpen) {
      setNewSessionOpen(false);
      return;
    }
    closeSession();
  }, [
    actionsRow,
    closeReview,
    closeSession,
    filePreviewShown,
    newSessionOpen,
    newSessionSheet,
    reviewShown,
    sessionOpen
  ]);
  useMobileBackNavigation(screenDepth, goBackOneScreen);

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
      // A phone is read at arm's length: host the type scale two levels above
      // the desktop default (6) so body text lands at 15px. The attribute
      // recomputes every --text-* token for the subtree; see tokens.css.
      data-font-size="8"
      data-screen={sessionOpen ? "session" : newSessionOpen ? "new" : "list"}
    >
      {!sessionOpen && newSessionOpen ? (
        <NewSessionScreen
          projects={snapshot.projects.filter((project) => project.id !== SCRATCH_PROJECT_ID)}
          onClose={() => setNewSessionOpen(false)}
          onLaunched={handleLaunched}
          onError={(message) => showToast({ kind: "error", message })}
          openSheet={newSessionSheet}
          onOpenSheetChange={setNewSessionSheet}
        />
      ) : reviewShown && selectedWorkspace ? (
        <Suspense
          fallback={<LinesSkeleton rows={10} label="Loading changes" className="review-diff-skeleton" />}
        >
          <MobileReviewScreen
            workspace={selectedWorkspace}
            initialFilePath={reviewFilePath}
            filePreviewOpen={reviewFilePreviewOpen}
            onFilePreviewOpenChange={setReviewFilePreviewOpen}
            onClose={closeReview}
          />
        </Suspense>
      ) : sessionOpen ? (
        <div className="mobile-session-screen">
          <MobileScreenHeader
            onBack={closeSession}
            backLabel="Back to sessions"
            title={selectedWorkspace?.taskLabel ?? ""}
            actions={
              selectedWorkspace ? (
                <>
                  <button
                    type="button"
                    className="mobile-icon-button"
                    onClick={() => void archiveWorkspace(selectedWorkspace)}
                    aria-label="Archive session"
                  >
                    <Archive size={18} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="mobile-icon-button"
                    onClick={() => {
                      setReviewFilePath(null);
                      setReviewOpen(true);
                    }}
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
                </>
              ) : undefined
            }
          />
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
            onClearSession={commands.clearSession}
            onForkSession={forkSession}
            onOpenFile={(path) => {
              setReviewFilePath(path);
              setReviewOpen(true);
            }}
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
                  onOpenActions={setActionsRow}
                />
                <SessionSection
                  label={pinnedRows.length > 0 ? "Sessions" : "All sessions"}
                  rows={activityRows}
                  projectNamesById={projectNamesById}
                  nowMs={nowMs}
                  onOpen={openWorkspaceChat}
                  onOpenActions={setActionsRow}
                />
              </>
            )}
          </div>
        </div>
      )}
      {actionsRow ? (
        <BottomSheet label="Session actions" onClose={() => setActionsRow(null)}>
          <p className="mobile-sheet-group-label">{actionsRow.workspace.taskLabel}</p>
          <div className="mobile-sheet-group">
            <SheetOption
              label={actionsRow.workspace.pinned ? "Unpin" : "Pin to top"}
              onSelect={() => {
                const { workspace } = actionsRow;
                setActionsRow(null);
                void setPinned(workspace);
              }}
            />
            <SheetOption
              label="Rename"
              onSelect={() => {
                const { workspace } = actionsRow;
                setActionsRow(null);
                void renameWorkspace(workspace);
              }}
            />
            <SheetOption
              label="Archive"
              danger
              onSelect={() => {
                const { workspace } = actionsRow;
                setActionsRow(null);
                void archiveWorkspace(workspace);
              }}
            />
          </div>
        </BottomSheet>
      ) : null}
      {toast ? (
        <div className={`mobile-toast mobile-toast-${toast.kind}`} role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
