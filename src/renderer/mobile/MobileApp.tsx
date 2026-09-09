import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { FolderGit2, Laptop, Menu, MoreHorizontal, PenLine, Search } from "lucide-react";
import { FORK_CAPABLE_PROVIDERS } from "../../shared/providerModels.js";
import { SCRATCH_PROJECT_ID, type SessionSummary, type WorkspaceSummary } from "../../shared/types.js";
import { LinesSkeleton } from "../components/LinesSkeleton.js";
import { SessionPane } from "../components/SessionPane.js";
import { WorkingNest } from "../components/WorkingNest.js";
import type { NewSessionSeed } from "../components/SessionComposer.js";
import { BottomSheet, SheetOption } from "./BottomSheet.js";
import { takeDeepLinkSessionId } from "./deepLink.js";
import { MobileScreenHeader } from "./MobileScreenHeader.js";
import { NewSessionScreen, type PickerKind } from "./NewSessionScreen.js";
import { useMobileBackNavigation } from "./useMobileBackNavigation.js";
import { useVisualViewportInsets } from "./useVisualViewportInsets.js";
import { useDashboardSession } from "../hooks/useDashboardSession.js";
import { SessionTimelineProvider } from "../hooks/useSessionTimeline.js";
import { useSessionCommands } from "../hooks/useSessionCommands.js";
import { isEarlySessionStop } from "../lib/earlyStop.js";
import { hiddenMultitaskWorkspaceIds, isMultitaskSession, multitasksByParentSession } from "../lib/multitask.js";
import { importChunk } from "../lib/importChunk.js";
import { loadDashboardSnapshot } from "../lib/loadDashboardSnapshot.js";
import { useUnreadWorkspaceIds } from "../lib/sessionUnread.js";
import {
  computePriorityEntries,
  computeWorkspaceAttention,
  workingWorkspaceIds,
  type PriorityAttention
} from "../lib/priority.js";
import {
  ACCENT_OPTIONS,
  applyAccentToDocument,
  readStoredAccent,
  writeStoredAccent,
  type AccentId
} from "../lib/accent.js";
import {
  applyThemeToDocument,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type ResolvedTheme
} from "../lib/theme.js";
import {
  applyUserBubbleTintToDocument,
  isUserBubbleTint,
  readStoredUserBubbleTint,
  writeStoredUserBubbleTint,
  type UserBubbleTint
} from "../lib/userBubbleTint.js";
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

// Spoken names for the row's leading marker, matching the desktop row's
// title suffix. The marker replaces the old text chips: which kind of
// attention a row has is the Priority section's job to say, not the row's.
const AWAITING_LABEL: Record<"approval-needed" | "blocked", string> = {
  "approval-needed": "needs approval",
  blocked: "waiting for input"
};

interface SessionListRow {
  workspace: WorkspaceSummary;
  session: SessionSummary | null;
  attention: PriorityAttention | null;
  /** Own turn, or a multitask this chat dispatched — same set the desktop row uses. */
  working: boolean;
}

/**
 * Same gate the turn footer applies (SessionConversationTurn.tsx), mirroring
 * `fork_session` in orchestration.rs: only providers that can resume a copied
 * conversation, and never mid-turn — a running or waiting session would fork a
 * half-written transcript, so the backend refuses it.
 */
function isForkable(session: SessionSummary | null): session is SessionSummary {
  return (
    session !== null &&
    FORK_CAPABLE_PROVIDERS.has(session.provider) &&
    session.state !== "running" &&
    session.state !== "waiting"
  );
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
  unread,
  nowMs,
  onOpen,
  onOpenActions
}: {
  row: SessionListRow;
  projectName: string | null;
  unread: boolean;
  nowMs: number;
  onOpen: (workspaceId: string) => void;
  onOpenActions: (row: SessionListRow) => void;
}): JSX.Element {
  const { workspace, session, attention, working } = row;
  // Same precedence as the desktop row's status marker: an input-starved
  // session outranks a running one, since the whole point of the row is that
  // the agent is stalled on you and approvals arrive mid-turn.
  const awaiting = attention === "approval-needed" || attention === "blocked" ? attention : null;
  const age = relativeAge(session?.lastActivityAt ?? workspace.lastActivityAt, nowMs);
  return (
    // The actions button is a sibling of the open button, not nested inside
    // it: a button within a button is invalid and swallows the inner tap.
    <li className="mobile-session-item">
      <button
        type="button"
        className="mobile-session-row"
        data-attention={attention ?? undefined}
        data-running={working || undefined}
        onClick={() => onOpen(workspace.id)}
      >
        <span className="mobile-session-text">
          <span className="mobile-session-title-line">
            {awaiting ? (
              <span
                className="mobile-session-marker"
                data-attention={awaiting}
                aria-label={AWAITING_LABEL[awaiting]}
              />
            ) : working ? (
              // The nest moves and the unread dot does not, which is the whole
              // distinction: two accent dots, one pulsing, read as the same
              // thing at a glance on a phone.
              <span className="mobile-session-nest" aria-label="running">
                <WorkingNest active size={11} />
              </span>
            ) : unread ? (
              <span className="mobile-session-marker" data-unread aria-label="unread reply" />
            ) : null}
            <span className="mobile-session-title">{workspace.taskLabel}</span>
          </span>
          <span className="mobile-session-subtitle">
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
        aria-label="Chat actions"
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
  unreadIds,
  nowMs,
  onOpen,
  onOpenActions
}: {
  label: string;
  rows: SessionListRow[];
  projectNamesById: Map<string, string>;
  unreadIds: ReadonlySet<string>;
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
            unread={unreadIds.has(row.workspace.id)}
            nowMs={nowMs}
            onOpen={onOpen}
            onOpenActions={onOpenActions}
          />
        ))}
      </ul>
    </section>
  );
}

function MobileSegmentedControl({
  ariaLabel,
  value,
  onChange,
  options
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <div className="mobile-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function MobileAccentPicker({
  value,
  onChange
}: {
  value: AccentId;
  onChange: (accentId: AccentId) => void;
}): JSX.Element {
  return (
    <div className="mobile-accent-picker" role="radiogroup" aria-label="Accent">
      {ACCENT_OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            className="mobile-accent-chip"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            data-accent-id={option.id}
            data-selected={selected || undefined}
            title={option.label}
            onClick={() => onChange(option.id)}
          />
        );
      })}
    </div>
  );
}

function MobileAppearanceControls({
  theme,
  onThemeChange,
  accentId,
  onAccentChange,
  userBubbleTint,
  onUserBubbleTintChange
}: {
  theme: ResolvedTheme;
  onThemeChange: (theme: ResolvedTheme) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  userBubbleTint: UserBubbleTint;
  onUserBubbleTintChange: (tint: UserBubbleTint) => void;
}): JSX.Element {
  return (
    <>
      <p className="mobile-sheet-group-label">Theme</p>
      <div className="mobile-sheet-group">
        <MobileSegmentedControl
          ariaLabel="Theme"
          value={theme}
          onChange={(next) => {
            if (next === "light" || next === "dark") onThemeChange(next);
          }}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" }
          ]}
        />
      </div>
      <p className="mobile-sheet-group-label">Accent</p>
      <div className="mobile-sheet-group">
        <MobileAccentPicker value={accentId} onChange={onAccentChange} />
      </div>
      <p className="mobile-sheet-group-label">Your message bubbles</p>
      <div className="mobile-sheet-group">
        <MobileSegmentedControl
          ariaLabel="Your message bubbles"
          value={userBubbleTint}
          onChange={(next) => {
            if (isUserBubbleTint(next)) onUserBubbleTintChange(next);
          }}
          options={[
            { value: "accent", label: "Accent" },
            { value: "neutral", label: "Neutral" }
          ]}
        />
      </div>
    </>
  );
}

export function MobileApp(): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  useVisualViewportInsets(shellRef);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Backgrounding the phone kills the socket on every app switch, so requests
  // caught mid-flight fail with the connection-lost message as a matter of
  // routine. The "Reconnecting…" banner is the honest signal; the toast is not.
  const showToast = useCallback((next: ToastMessage) => {
    if (next.kind === "error" && next.message === REMOTE_CONNECTION_LOST_MESSAGE) return;
    setToast(next);
  }, []);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()));
  const [accentId, setAccentId] = useState<AccentId>(() => readStoredAccent());
  const [userBubbleTint, setUserBubbleTint] = useState<UserBubbleTint>(() =>
    readStoredUserBubbleTint()
  );
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
  useEffect(() => {
    writeStoredAccent(accentId);
    applyAccentToDocument(accentId);
  }, [accentId]);
  useEffect(() => {
    writeStoredUserBubbleTint(userBubbleTint);
    applyUserBubbleTintToDocument(userBubbleTint);
  }, [userBubbleTint]);
  const pickTheme = useCallback((next: ResolvedTheme) => {
    writeStoredTheme(next);
    setTheme(next);
  }, []);

  const {
    snapshot,
    timelines,
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

  const handleEarlyStop = useCallback(
    (sessionId: string): string | undefined => {
      const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
      if (!session || !isEarlySessionStop(session)) return undefined;
      // A multitask has no list row; stopping it must not archive the
      // workspace out from under the chat that dispatched it.
      if (isMultitaskSession(session)) return undefined;
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setSelectedWorkspaceId(null);
      }
      return session.workspaceId;
    },
    [selectedSessionId, setSelectedSessionId, setSelectedWorkspaceId, snapshot.sessions]
  );

  const commands = useSessionCommands({
    refreshDashboardStatus: refresh,
    loadSessionEvents,
    setToast: showToast,
    fastMode: false,
    onEarlyStop: handleEarlyStop
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
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Same set the desktop sidebar uses: a turn in flight here, or a
  // multitask this chat dispatched. The child's own workspace has no list
  // row, so this is the only place that work can still read as live.
  const hiddenMultitasks = useMemo(
    () => hiddenMultitaskWorkspaceIds(snapshot.sessions),
    [snapshot.sessions]
  );
  const workingWorkspaces = useMemo(
    () => workingWorkspaceIds(snapshot.sessions),
    [snapshot.sessions]
  );

  const sessionOpen = selectedWorkspaceId !== null && (selectedSession !== null || selectedSessionId !== null);
  // Unread is this phone's own reading state: the stamp lives in its
  // localStorage, so reading a chat on the Mac does not clear the dot here,
  // and reading it here does not clear it there. Passing the open chat only
  // while it is on screen lets a reply that lands after you back out count
  // as unread again.
  const workspaceActivity = useMemo(
    () =>
      snapshot.workspaces.map((workspace) => ({
        id: workspace.id,
        lastActivityAt: workspace.lastActivityAt ?? ""
      })),
    [snapshot.workspaces]
  );
  const unreadIds = useUnreadWorkspaceIds(
    workspaceActivity,
    sessionOpen ? selectedWorkspaceId : null,
    workingWorkspaces
  );

  // Three sections, same shape and precedence as the desktop sidebar: Pinned
  // on top, then Priority (working rows first, then the rest by last message),
  // then everything else newest-activity first. A row lives in exactly one of
  // them. Priority ages rows out 30 minutes after their last message, which
  // the shared minute clock below is close enough to notice.
  const { pinnedRows, priorityRows, activityRows } = useMemo(() => {
    const sessionsByWorkspace = new Map(snapshot.sessions.map((session) => [session.workspaceId, session]));
    const attentionByWorkspace = computeWorkspaceAttention(
      snapshot.workspaces,
      snapshot.sessions,
      nowMs,
      unreadIds
    );
    // A workspace with no session is a dead row: tapping it resolves no
    // session, so nothing opens. The desktop sidebar requires a session for
    // every section too, and the launcher's connection-lost path can strand
    // exactly such a workspace. A multitask is hidden for the same reason
    // the desktop hides it: it belongs to the chat that dispatched it.
    const visible = snapshot.workspaces.filter(
      (workspace) =>
        workspace.state !== "archived" &&
        workspace.kind !== "popup" &&
        !hiddenMultitasks.has(workspace.id) &&
        sessionsByWorkspace.has(workspace.id)
    );
    const rowsById = new Map<string, SessionListRow>(
      visible.map((workspace) => [
        workspace.id,
        {
          workspace,
          session: sessionsByWorkspace.get(workspace.id) ?? null,
          attention: attentionByWorkspace.get(workspace.id)?.attention ?? null,
          working: workingWorkspaces.has(workspace.id)
        }
      ])
    );
    // Side chats are conversational by nature and never escalate into triage,
    // the same rule the desktop sidebar applies.
    const priorityRows = computePriorityEntries(
      visible.filter((workspace) => workspace.kind === "git"),
      snapshot.sessions,
      nowMs,
      unreadIds
    ).flatMap((entry) => rowsById.get(entry.workspace.id) ?? []);
    const promoted = new Set(priorityRows.map((row) => row.workspace.id));
    const activityOf = (row: SessionListRow): string =>
      row.session?.lastActivityAt ?? row.workspace.lastActivityAt ?? "";
    const rest = [...rowsById.values()]
      .filter((row) => !promoted.has(row.workspace.id))
      .sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
    return {
      pinnedRows: rest.filter((row) => row.workspace.pinned),
      priorityRows,
      activityRows: rest.filter((row) => !row.workspace.pinned)
    };
  }, [hiddenMultitasks, nowMs, snapshot.sessions, snapshot.workspaces, unreadIds, workingWorkspaces]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return { pinnedRows, priorityRows, activityRows };
    const matches = (row: SessionListRow): boolean => {
      const projectName = projectNamesById.get(row.workspace.projectId) ?? "";
      return `${row.workspace.taskLabel} ${projectName}`.toLocaleLowerCase().includes(query);
    };
    return {
      pinnedRows: pinnedRows.filter(matches),
      priorityRows: priorityRows.filter(matches),
      activityRows: activityRows.filter(matches)
    };
  }, [activityRows, pinnedRows, priorityRows, projectNamesById, searchQuery]);

  // Full-screen Changes/Files view for the open session.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Set when a file reference in the transcript was tapped, so the review
  // screen lands on that file instead of the tree root.
  const [reviewFilePath, setReviewFilePath] = useState<string | null>(null);
  // The review screen's Files drill-down (tree → file) is a screen of its own
  // for a back gesture, so its open state lives here rather than inside it.
  const [reviewFilePreviewOpen, setReviewFilePreviewOpen] = useState(false);
  const [reviewScopeSheetOpen, setReviewScopeSheetOpen] = useState(false);
  // Dismisser from SessionPane while the delegated-work overlay is up. Stored
  // as a function value (`() => dismiss`), never as the updater itself.
  const [dismissAgentsOverlay, setDismissAgentsOverlay] = useState<(() => void) | null>(null);

  const closeReview = useCallback(() => {
    setReviewOpen(false);
    setReviewFilePreviewOpen(false);
    setReviewScopeSheetOpen(false);
  }, []);

  const closeSession = useCallback(() => {
    closeReview();
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [closeReview, setSelectedSessionId, setSelectedWorkspaceId]);

  // Same dirty-worktree rules as the desktop sidebar: confirm before moving a
  // dirty checkout to recovery, and re-prompt once when the backend's fresh
  // status check finds changes the cached snapshot missed ("kept" result).
  const archiveWorkspace = useCallback(
    async (workspace: WorkspaceSummary): Promise<void> => {
      if (!window.argmax) return;
      const confirmArchive = (taskLabel: string, changedFiles: number): boolean => {
        const fileLabel = changedFiles === 1 ? "1 uncommitted change" : `${changedFiles} uncommitted changes`;
        return window.confirm(
          `${taskLabel} has ${fileLabel}. Archive this worktree and keep its files in recovery storage?`
        );
      };
      let force = false;
      if (workspace.dirty && !workspace.sharedWorkspace) {
        if (!confirmArchive(workspace.taskLabel, workspace.changedFiles)) return;
        force = true;
      }
      try {
        let result = await window.argmax.workspaces.archive({ workspaceId: workspace.id, force });
        if (result.workspace.state === "kept" && !force && !result.workspace.sharedWorkspace) {
          if (!confirmArchive(result.workspace.taskLabel, result.workspace.changedFiles)) return;
          result = await window.argmax.workspaces.archive({ workspaceId: workspace.id, force: true });
        }
        if (result.workspace.state !== "archived") {
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
          message: error instanceof Error ? error.message : "Couldn't fork the chat."
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
      const nextLabel = window.prompt("Chat name", workspace.taskLabel)?.trim();
      if (!nextLabel || nextLabel === workspace.taskLabel) return;
      try {
        await window.argmax.workspaces.setLabel({ workspaceId: workspace.id, taskLabel: nextLabel });
      } catch (error) {
        showToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't rename the chat."
        });
      }
      await refresh();
    },
    [refresh, showToast]
  );

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionWorkspaceId, setNewSessionWorkspaceId] = useState<string | null>(null);
  const [newSessionSeed, setNewSessionSeed] = useState<NewSessionSeed | null>(null);
  // New-session picker state lives here, not inside that screen, so a back
  // gesture can dismiss a picker without discarding the typed prompt.
  const [newSessionSheet, setNewSessionSheet] = useState<PickerKind | null>(null);

  const startNewChatFromWorkspace = useCallback(
    (workspace: WorkspaceSummary, seed?: NewSessionSeed) => {
      setNewSessionWorkspaceId(workspace.id);
      setNewSessionSeed(seed ?? null);
      setNewSessionOpen(true);
    },
    []
  );

  const startNewChat = useCallback(() => {
    setNewSessionWorkspaceId(null);
    setNewSessionSeed(null);
    setNewSessionOpen(true);
  }, []);

  const closeNewSession = useCallback(() => {
    setNewSessionOpen(false);
    setNewSessionWorkspaceId(null);
    setNewSessionSeed(null);
    setNewSessionSheet(null);
  }, []);

  const handleLaunched = useCallback(
    async (workspaceId: string): Promise<void> => {
      // The snapshot predates the new workspace; refresh before opening it so
      // openWorkspaceChat can resolve the row.
      await refresh();
      closeNewSession();
      openWorkspaceChat(workspaceId);
    },
    [closeNewSession, openWorkspaceChat, refresh]
  );

  // The phone has no dock: with no `multitasks` handed to the pane, a multitask
  // row opens the chat itself rather than a tab beside this one. Opening it here is the same
  // move as tapping that chat's row in the list.
  const openSessionById = useCallback(
    (sessionId: string): void => {
      const target = snapshot.sessions.find((session) => session.id === sessionId);
      if (!target) return;
      openWorkspaceChat(target.workspaceId);
    },
    [openWorkspaceChat, snapshot.sessions]
  );

  // Chats this one dispatched. The phone has no dock to host them, so they
  // open in the overlay beside the subagents rather than replacing the chat.
  const multitasksByParent = useMemo(
    () => multitasksByParentSession(snapshot.sessions, snapshot.workspaces),
    [snapshot.sessions, snapshot.workspaces]
  );
  // Park the list under a session or the new-chat screen instead of unmounting
  // it: tearing the scroller down was sending every back-to-list gesture to
  // the top. It keeps its own type scale while the shell steps up for the
  // chat, so the parked scroller does not reflow and lose its offset.
  const listParked = sessionOpen || newSessionOpen || appearanceOpen;
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listScrollTopRef = useRef(0);
  // Remember the offset only while the list is the front screen. Parking can
  // hide it under a keyboard-sized shell that clamps scrollTop to 0; writing
  // that back would undo the restore.
  useLayoutEffect(() => {
    if (listParked) return;
    const node = listScrollRef.current;
    if (node) node.scrollTop = listScrollTopRef.current;
  }, [listParked]);
  // Mirrors the render below: the review screen needs a workspace to draw, and
  // a workspace that drops out of the snapshot must take its history entry
  // with it, or one back press changes nothing on screen.
  const reviewShown = sessionOpen && reviewOpen && selectedWorkspace !== null;
  const sessionParked = newSessionOpen || reviewShown || appearanceOpen;
  // A sheet is a screen as far as a back gesture is concerned: without this,
  // back on the list screen leaves the app with the sheet still up, and back
  // on the New session screen tears the screen down under an open picker.
  const sheetOpen =
    actionsRow !== null || listMenuOpen || newSessionSheet !== null || reviewScopeSheetOpen;

  const filePreviewShown = reviewShown && reviewFilePreviewOpen;

  // Overlay counts only while the session is the front screen. Parked under
  // review or New chat it is not what a back gesture would pop.
  const agentOverlayShown =
    sessionOpen && !sessionParked && dismissAgentsOverlay !== null;

  // Screen depth for the hardware back button: list → session/new → review →
  // file preview, plus one for an open sheet or the agent overlay.
  const screenDepth =
    (appearanceOpen
      ? 1
      : newSessionOpen
      ? sessionOpen
        ? 2
        : 1
      : sessionOpen
        ? reviewShown
          ? filePreviewShown
            ? 3
            : 2
          : agentOverlayShown
            ? 2
            : 1
          : 0) + (sheetOpen ? 1 : 0);
  const goBackOneScreen = useCallback((): void => {
    if (actionsRow !== null) {
      setActionsRow(null);
      return;
    }
    if (listMenuOpen) {
      setListMenuOpen(false);
      return;
    }
    if (newSessionSheet !== null) {
      setNewSessionSheet(null);
      return;
    }
    if (reviewScopeSheetOpen) {
      setReviewScopeSheetOpen(false);
      return;
    }
    if (appearanceOpen) {
      setAppearanceOpen(false);
      return;
    }
    if (newSessionOpen) {
      closeNewSession();
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
    if (dismissAgentsOverlay) {
      dismissAgentsOverlay();
      return;
    }
    closeSession();
  }, [
    actionsRow,
    appearanceOpen,
    closeNewSession,
    closeReview,
    closeSession,
    dismissAgentsOverlay,
    filePreviewShown,
    listMenuOpen,
    newSessionOpen,
    newSessionSheet,
    reviewScopeSheetOpen,
    reviewShown
  ]);
  useMobileBackNavigation(screenDepth, goBackOneScreen);

  const empty =
    filteredRows.pinnedRows.length === 0 &&
    filteredRows.priorityRows.length === 0 &&
    filteredRows.activityRows.length === 0;
  // Slim enough to sit under either header without displacing the screen it
  // belongs to; the list and the conversation stay usable while it shows.
  const connectionBanner =
    connection.status === "connected" ? null : (
      <div className="mobile-connection-banner" role="status" aria-label="Reconnecting">
        Reconnecting…
      </div>
    );

  return (
    <SessionTimelineProvider store={timelines}>
    <div
      ref={shellRef}
      className="mobile-shell"
      data-font-size={
        // Reading a transcript wants a larger type than scanning a list of
        // chats does, so the two screens run at their own scale.
        sessionOpen || newSessionOpen ? "7" : "3"
      }
      data-screen={newSessionOpen ? "new" : sessionOpen ? "session" : "list"}
    >
      <div
        className="mobile-list-screen"
        data-font-size="3"
        data-parked={listParked || undefined}
        aria-hidden={listParked}
        inert={listParked || undefined}
      >
        <header className="mobile-list-header">
          <button
            type="button"
            className="mobile-icon-button"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={listMenuOpen}
            onClick={() => setListMenuOpen(true)}
          >
            <Menu size={21} aria-hidden />
          </button>
          <div className="mobile-list-identity">
            <h1>Remote</h1>
            <span className="mobile-list-device">
              <span className="mobile-list-device-dot" aria-hidden="true" />
              <Laptop size={14} aria-hidden="true" />
              <span>Mac</span>
            </span>
          </div>
          <div className="mobile-list-header-actions">
            <button
              type="button"
              className="mobile-icon-button"
              aria-label="Remote options"
              aria-haspopup="dialog"
              aria-expanded={listMenuOpen}
              onClick={() => setListMenuOpen(true)}
            >
              <MoreHorizontal size={21} aria-hidden />
            </button>
          </div>
        </header>
        {connectionBanner}
        {/* The scroller is the list landmark: sections come and go with
            triage, so this is the one stable handle on "the sessions". */}
        <div
          ref={listScrollRef}
          className="mobile-list-scroll"
          role="region"
          aria-label="Chat list"
          onScroll={(event) => {
            if (!listParked) listScrollTopRef.current = event.currentTarget.scrollTop;
          }}
        >
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
              <p>
                {loadState === "loading"
                  ? "Connecting…"
                  : searchQuery.trim()
                    ? `No chats match “${searchQuery.trim()}”.`
                    : "No active chats."}
              </p>
            </div>
          ) : (
            <>
              <SessionSection
                label="Pinned"
                rows={filteredRows.pinnedRows}
                projectNamesById={projectNamesById}
                unreadIds={unreadIds}
                nowMs={nowMs}
                onOpen={openWorkspaceChat}
                onOpenActions={setActionsRow}
              />
              <SessionSection
                label="Priority"
                rows={filteredRows.priorityRows}
                projectNamesById={projectNamesById}
                unreadIds={unreadIds}
                nowMs={nowMs}
                onOpen={openWorkspaceChat}
                onOpenActions={setActionsRow}
              />
              <SessionSection
                label={filteredRows.pinnedRows.length > 0 || filteredRows.priorityRows.length > 0 ? "Chats" : "All chats"}
                rows={filteredRows.activityRows}
                projectNamesById={projectNamesById}
                unreadIds={unreadIds}
                nowMs={nowMs}
                onOpen={openWorkspaceChat}
                onOpenActions={setActionsRow}
              />
            </>
          )}
        </div>
        <div className="mobile-list-dock">
          <label className="mobile-list-search">
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search chats"
              placeholder="Search chats"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="mobile-list-compose"
            aria-label="New chat"
            onClick={startNewChat}
          >
            <PenLine size={23} aria-hidden="true" />
          </button>
        </div>
      </div>
      {sessionOpen ? (
        <div
          className="mobile-screen-overlay"
          data-parked={sessionParked || undefined}
          aria-hidden={sessionParked || undefined}
          inert={sessionParked || undefined}
        >
            <div className="mobile-session-screen">
              <MobileScreenHeader
                onBack={closeSession}
                backLabel="Back to chats"
                title={selectedWorkspace?.taskLabel ?? ""}
                actions={
                  selectedWorkspace ? (
                    <>
                      {/* Only changes live here. Starting a chat and archiving
                          one are both a tap away in the list's row menu, and
                          three icons crowded a bar whose left half is a title
                          that needs the room. */}
                      {/* A side chat runs in an app-owned scratch directory with
                          one empty commit, so this button would open a permanently
                          empty diff and an empty tree. Tapping a file the agent
                          wrote there still opens the review screen from the
                          transcript — only the standing entry point is dropped. */}
                      {selectedWorkspace.kind === "git" ? (
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
                      ) : null}
                    </>
                  ) : undefined
                }
              />
              {connectionBanner}
              <SessionPane
                approvals={snapshot.approvals}
                checks={snapshot.checks}
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
                onMultitask={commands.multitask}
                onOpenSession={openSessionById}
                onClearSession={commands.clearSession}
                onForkSession={forkSession}
                onNewSession={
                  selectedWorkspace
                    ? (seed) => startNewChatFromWorkspace(selectedWorkspace, seed)
                    : undefined
                }
                onOpenFile={(path) => {
                  setReviewFilePath(path);
                  setReviewOpen(true);
                }}
                multitasks={selectedSession ? (multitasksByParent.get(selectedSession.id) ?? []) : []}
                agentsViewAvailable={false}
                agentsPresentation="overlay"
                onAgentsOverlayChange={(dismiss) => setDismissAgentsOverlay(() => dismiss)}
                workspaceCardVisible={false}
              />
            </div>
        </div>
      ) : null}
      {appearanceOpen ? (
        <div className="mobile-screen-overlay">
            <div className="mobile-settings-screen">
              <MobileScreenHeader
                onBack={() => setAppearanceOpen(false)}
                backLabel="Back to chats"
                title="Appearance"
              />
              <div className="mobile-settings-body">
                <MobileAppearanceControls
                  theme={theme}
                  onThemeChange={pickTheme}
                  accentId={accentId}
                  onAccentChange={setAccentId}
                  userBubbleTint={userBubbleTint}
                  onUserBubbleTintChange={setUserBubbleTint}
                />
              </div>
            </div>
        </div>
      ) : newSessionOpen ? (
        <div className="mobile-screen-overlay">
            <NewSessionScreen
              projects={snapshot.projects.filter((project) => project.id !== SCRATCH_PROJECT_ID)}
              workspaces={snapshot.workspaces}
              initialWorkspaceId={newSessionWorkspaceId}
              initialSeed={newSessionSeed}
              backLabel={sessionOpen ? "Back to chat" : "Back to chats"}
              onClose={closeNewSession}
              onLaunched={handleLaunched}
              onError={(message) => showToast({ kind: "error", message })}
              openSheet={newSessionSheet}
              onOpenSheetChange={setNewSessionSheet}
            />
        </div>
      ) : reviewShown && selectedWorkspace ? (
        <div className="mobile-screen-overlay">
            <Suspense
              fallback={<LinesSkeleton rows={10} label="Loading changes" className="review-diff-skeleton" />}
            >
              <MobileReviewScreen
                workspace={selectedWorkspace}
                initialFilePath={reviewFilePath}
                filePreviewOpen={reviewFilePreviewOpen}
                onFilePreviewOpenChange={setReviewFilePreviewOpen}
                scopeSheetOpen={reviewScopeSheetOpen}
                onScopeSheetOpenChange={setReviewScopeSheetOpen}
                onClose={closeReview}
              />
            </Suspense>
        </div>
      ) : null}
      {listMenuOpen ? (
        <BottomSheet label="Remote menu" onClose={() => setListMenuOpen(false)}>
          <p className="mobile-sheet-group-label">Remote</p>
          <div className="mobile-sheet-group">
            <SheetOption
              label="New chat"
              detail="Pick a project and start fresh"
              onSelect={() => {
                setListMenuOpen(false);
                startNewChat();
              }}
            />
            <SheetOption
              label="Appearance"
              detail="Theme, accent, message bubbles"
              onSelect={() => {
                setListMenuOpen(false);
                setAppearanceOpen(true);
              }}
            />
          </div>
        </BottomSheet>
      ) : null}
      {actionsRow ? (
        <BottomSheet label="Chat actions" onClose={() => setActionsRow(null)}>
          <p className="mobile-sheet-group-label">{actionsRow.workspace.taskLabel}</p>
          <div className="mobile-sheet-group">
            <SheetOption
              label="New chat here"
              onSelect={() => {
                const { workspace } = actionsRow;
                setActionsRow(null);
                startNewChatFromWorkspace(workspace);
              }}
            />
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
            {isForkable(actionsRow.session) ? (
              <SheetOption
                label="Fork chat"
                detail="Copy it into a new chat and continue there"
                onSelect={() => {
                  const { session } = actionsRow;
                  if (!session) return;
                  setActionsRow(null);
                  void forkSession(session.id);
                }}
              />
            ) : null}
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
    </SessionTimelineProvider>
  );
}
