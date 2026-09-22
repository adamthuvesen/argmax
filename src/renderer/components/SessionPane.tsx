import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { ModelPickerSelection } from "../lib/models.js";
import type { QueuedMessageDelivery } from "../../shared/types.js";
import type { NewSessionSeed } from "./SessionComposer.js";
import type { DiffNoteInput } from "../lib/composerAnnotations.js";
import type { MultitaskChild } from "../lib/multitask.js";
import type {
  AgentMode,
  AgentReference,
  ApprovalRequest,
  CheckRun,
  ComposerAttachment,
  DetectedIde,
  IdeId,
  NativeAgentIdentity,
  PendingMessage,
  ProjectSummary,
  ProviderId,
  SessionSummary,
  WorkspaceSummary
} from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import type { FontSize } from "../lib/fonts.js";
import { useSessionTimeline } from "../hooks/useSessionTimeline.js";
import { CHAT_PANE_MIN_WIDTH_PX } from "../lib/layoutConstants.js";
import { useStableFilter } from "../hooks/useStableFilter.js";
import { lastTurnEditedPaths } from "../lib/lastTurnFiles.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import { showErrorToast } from "../state/toast.js";
import { readStoredReviewPanelSide } from "../lib/reviewPanelSide.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { readBoundedNumberPreference, type FollowUpDelivery, type ThinkingDisplay, type ToolCallsDisplay } from "../lib/uiPreferences.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { agentTabId, multitaskTabId } from "../lib/agentTabs.js";
import { useAgentTabs } from "../hooks/useAgentTabs.js";
import { importChunk } from "../lib/importChunk.js";
import { CommitDialog } from "./CommitDialog.js";
import { ApprovalSurface } from "./ApprovalSurface.js";
import { DebugPanel } from "./debug/DebugPanel.js";
// ReviewPanel lazy-mounted (ralph B4); Vite emits a single ReviewPanel-*
// chunk shared with the LaunchSurface call site.
// The phone's peek at delegated work. Lazy for the same reason ReviewPanel is:
// most sessions never open one. Named imports so a surface that *can* raise
// the peek warms them on idle — a lazy chunk fetched on the tap paints an
// empty sheet for as long as it takes to arrive.
const importAgentOverlay = () => import("../mobile/AgentOverlay.js");
const importAgentsView = () => import("./AgentsView.js");
const AgentOverlay = lazy(() =>
  importChunk(async () => ({
    default: (await importAgentOverlay()).AgentOverlay
  }))
);
const AgentsView = lazy(() =>
  importChunk(async () => ({
    default: (await importAgentsView()).AgentsView
  }))
);
const ReviewPanel = lazy(() =>
  importChunk(async () => ({
    default: (await import("./ReviewPanel.js")).ReviewPanel
  }))
);
import { SessionConversation } from "./SessionConversation.js";
// TerminalTabsPanel pulls in @xterm/xterm + addons + xterm CSS — heavy and
// only loaded when the user opens the review panel's Terminal view, which
// mounts it. Named here so this pane can prefetch the chunk on idle (see the
// warm-up effect below) and the first ⌘J paints straight away.
const importTerminalView = () => import("./TerminalTabsPanel.js");

/** Only written once the user drags the handle. The old key held the width on
 *  every mount, default included, so a stored value there could not be told
 *  from a chosen one; this key means "the user picked this". */
const SESSION_RIGHT_PANEL_WIDTH_KEY = "argmax.session.rightPanel.pinnedWidth";
const SESSION_RIGHT_PANEL_MIN = 360;
const SESSION_RIGHT_PANEL_MAX = 2000;
/** Until the handle is dragged the dock takes a third of the pane rather than
 *  a fixed 420px — on a pane under a thousand pixels that fixed width read as
 *  an even split with the chat, which is more than a subagent transcript or a
 *  file list needs. The floor is the drag minimum, so the automatic width is
 *  always one the handle can return to; the ceiling keeps a very wide window
 *  from handing the dock a third of the screen. */
const SESSION_RIGHT_PANEL_AUTO_WIDTH = `clamp(${SESSION_RIGHT_PANEL_MIN}px, 33.3%, 560px)`;
const SESSION_LOG_PANEL_MIN = 300;

/** Null when the user has never dragged the handle, which leaves the dock on
 *  `SESSION_RIGHT_PANEL_AUTO_WIDTH` instead of freezing it at a stored width. */
function readPinnedPanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  if (window.localStorage.getItem(SESSION_RIGHT_PANEL_WIDTH_KEY) === null) return null;
  return readBoundedNumberPreference(SESSION_RIGHT_PANEL_WIDTH_KEY, {
    min: SESSION_RIGHT_PANEL_MIN,
    max: SESSION_RIGHT_PANEL_MAX,
    fallback: SESSION_RIGHT_PANEL_MIN
  });
}

function writePinnedPanelWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_RIGHT_PANEL_WIDTH_KEY, String(width));
  } catch {
    // Quota or private-mode failures are non-fatal for a panel width.
  }
}

export function SessionPane({
  approvals,
  checks,
  chatFontSize,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  thinkingDisplay,
  defaultTurnChangesExpanded,
  defaultFollowUpDelivery,
  goalEnabled,
  goalMaxTurns,
  revertEnabled,
  fastModeEnabled = false,
  isFocused = true,
  onClose,
  onFastModeEnabledChange,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onNewSession,
  onOpenChanges,
  onOpenFile,
  onOpenSideChat,
  onOpenSession,
  onOpenDetails,
  defaultIde = null,
  detectedIdes = [],
  onOpenWorkspaceInIde,
  onRightPanelWidthChange,
  onResolveApproval,
  onRunCheck,
  onSendSessionInput,
  onCancelQueuedMessage,
  onSendQueuedMessageNow,
  onMultitask,
  multitasks,
  pendingMessages,
  onTerminateSession,
  onClearSession,
  onForkSession,
  project,
  registerPaletteFileContext,
  rightPanelToggleSignal,
  debugLogToggleSignal,
  session,
  agentsViewAvailable = true,
  agentsPresentation = "dock",
  onAgentsOverlayChange,
  nativeComposerFloor = false,
  workspaceCardVisible = true,
  onWorkspaceCardVisibleChange,
  contextIndicatorEnabled = false,
  workspace
}: {
  approvals: ApprovalRequest[];
  checks?: CheckRun[];
  /** Settings → Appearance: the font scale shared by the transcript and composer. */
  chatFontSize?: FontSize;
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  thinkingDisplay?: ThinkingDisplay;
  defaultTurnChangesExpanded?: boolean;
  defaultFollowUpDelivery?: FollowUpDelivery;
  /** Settings → Agents → Conversation: show the goal strip / checkpoints panel. */
  goalEnabled?: boolean;
  goalMaxTurns?: number;
  revertEnabled?: boolean;
  fastModeEnabled?: boolean;
  /** When false, the pane skips its document-level keyboard shortcuts so only the focused pane reacts. */
  isFocused?: boolean;
  /** Close button is shown when provided. Used by the multi-pane grid; absent in single-pane mode. */
  onClose?: () => void;
  onOpenFile?: (path: string, opts?: { line?: number | null; preferIde?: boolean }) => void;
  /** Opens the host's own changes surface with no file picked. Only a host
   *  that owns one supplies it (the phone's review screen); the desktop opens
   *  its dock through this pane's own review state instead. */
  onOpenChanges?: () => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  /** Called on mount and on session.id change to backfill timeline events for this pane's session. */
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  /** Backfills one subagent's child rows, for the review panel's Agents view. */
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string, identity?: NativeAgentIdentity) => Promise<void | { hasMore: boolean }>;
  /** Opens a launcher pane beside this one. Absent outside the grid. */
  onNewSession?: (seed?: NewSessionSeed) => void;
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
  onOpenDetails?: (
    seedPrompt: string,
    context?: { attachToChat?: () => void }
  ) => Promise<void>;
  defaultIde?: IdeId | null;
  detectedIdes?: DetectedIde[];
  onOpenWorkspaceInIde?: (workspaceId: string, ide: IdeId) => void;
  onRightPanelWidthChange?: (width: number | null) => void;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[],
    agentReferences?: AgentReference[],
    delivery?: FollowUpDelivery
  ) => Promise<void>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow: (
    sessionId: string,
    messageId: string,
    delivery?: QueuedMessageDelivery
  ) => Promise<void>;
  onMultitask?: (
    sessionId: string,
    prompt: string,
    provider: ProviderId,
    pendingMessageId?: string
  ) => Promise<void>;
  /** Multitasks dispatched from this pane's session. They have no sidebar row
   *  of their own — this pane's dock is where they are read and answered. */
  multitasks?: MultitaskChild[];
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onForkSession?: (sessionId: string) => Promise<void>;
  project: ProjectSummary | null;
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  session: SessionSummary | null;
  /** Whether this surface has a dock to host the Agents view. False on the
      phone, where a launch row is a record of the delegated work, not a way in. */
  agentsViewAvailable?: boolean;
  /** Where a tapped subagent or multitask row opens. "dock" is the desktop's
   *  review panel; "overlay" raises a sheet over the transcript, which is what
   *  the phone has room for. */
  agentsPresentation?: "dock" | "overlay";
  /** Phone back-stack: called with a dismisser while the overlay is on
   *  screen — rising, up, or riding out — and with null once it has gone, so
   *  a hardware back can pop the peek first and the native host knows when
   *  its floor is clear to take back. The dismisser is the sheet's own, so
   *  back rides out the same way a tap on the scrim does; during the ride
   *  out it is a no-op. */
  onAgentsOverlayChange?: (dismiss: (() => void) | null) => void;
  /** Whether the host draws the composer natively below the web view. Raising
   *  the peek hands that floor back, which resizes the page: the sheet waits
   *  for the new height before it rises rather than animating into it. */
  nativeComposerFloor?: boolean;
  /** User preference for the floating workspace card. Visible when enabled
      and the conversation column is wide enough to hold it beside the transcript. */
  workspaceCardVisible?: boolean;
  onWorkspaceCardVisibleChange?: (visible: boolean) => void;
  /** Settings → Appearance: show context-window usage in the active composer. */
  contextIndicatorEnabled?: boolean;
  workspace: WorkspaceSummary | null;
  /** When this pane is focused, it registers its workspace file source +
      review-pane file-pick handler with the command palette so its Files
      group routes to this pane's review panel. */
  registerPaletteFileContext?: (
    context: { source: { kind: "workspace" | "project"; id: string }; onPick: (path: string) => void } | null
  ) => void;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  // Wrap in useMemo so the hook's source identity is stable between renders —
  // otherwise a fresh object every render would invalidate downstream deps.
  const reviewSource = useMemo<ReviewSource | null>(
    () => (workspace ? { kind: "workspace", workspace } : null),
    [workspace]
  );
  const visibleApprovals = useStableFilter(approvals, sessionId, (approval) => approval.sessionId === sessionId);
  const { events: visibleEvents, rawOutputs: visibleRawOutputs } = useSessionTimeline(sessionId);
  const cursorBackgroundAgentIds = useMemo(() => {
    if (session?.provider !== "cursor") return [];
    return buildSessionToolCalls(
      visibleEvents,
      session.state === "running",
      session.state === "failed" || session.state === "cancelled"
    )
      .filter((tool) => tool.backgroundLaunch && tool.status === "running")
      .map((tool) => tool.toolUseId);
  }, [session?.provider, session?.state, visibleEvents]);
  // Keyed by value, and the poll reads the ids and the callback through refs:
  // every read merges into the timeline, which rebuilds the id array, and an
  // effect keyed on that array tore down its own timer and polled again on
  // every merge — one read per round trip instead of one per tick.
  const cursorBackgroundAgentKey = cursorBackgroundAgentIds.join(",");
  const cursorPollRef = useRef({ ids: cursorBackgroundAgentIds, onLoadAgentEvents });
  useEffect(() => {
    cursorPollRef.current = { ids: cursorBackgroundAgentIds, onLoadAgentEvents };
  });
  useEffect(() => {
    if (!sessionId || !onLoadAgentEvents || cursorBackgroundAgentKey === "") return;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (document.hidden || inFlight) return;
      const { ids, onLoadAgentEvents: load } = cursorPollRef.current;
      if (!load) return;
      inFlight = true;
      try {
        await Promise.all(ids.map((parentToolUseId) => load(sessionId, parentToolUseId)));
      } catch {
        // The next tick retries transient trace-read or IPC failures.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1500);
    return () => window.clearInterval(interval);
  }, [cursorBackgroundAgentKey, onLoadAgentEvents, sessionId]);
  // Which files the agent wrote in its newest turn, for the review panel's
  // "Last turn" scope. Null without a session: there is no turn to scope to.
  const lastTurnPaths = useMemo(() => lastTurnEditedPaths(visibleEvents), [visibleEvents]);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const reviewState = useReviewState(reviewSource, session ? lastTurnPaths : null, {
    claimsBrowserRequests: isFocused,
    preloadChanges: onOpenChanges ? undefined : isFocused || isCommitDialogOpen,
    sessionId
  });
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  // Null while the dock is on its automatic share of the pane; a pixel width
  // once the user has dragged the handle.
  const [pinnedPanelWidth, setPinnedPanelWidth] = useState<number | null>(readPinnedPanelWidth);
  const toggleLog = useCallback(() => setIsLogOpen((v) => !v), []);
  // The card's own dismiss and the session menu's checkbox write the same
  // app-level preference, so hiding it here keeps it hidden everywhere.
  const handleHideWorkspaceCard = useCallback(
    () => onWorkspaceCardVisibleChange?.(false),
    [onWorkspaceCardVisibleChange]
  );
  const handleToggleWorkspaceCard = useCallback(
    () => onWorkspaceCardVisibleChange?.(!workspaceCardVisible),
    [onWorkspaceCardVisibleChange, workspaceCardVisible]
  );
  const gridClass = [
    "session-grid",
    reviewState.isPanelOpen && "review-open",
    isLogOpen && "log-open"
  ]
    .filter(Boolean)
    .join(" ");
  const reviewColumnWidth =
    pinnedPanelWidth === null ? SESSION_RIGHT_PANEL_AUTO_WIDTH : `${pinnedPanelWidth}px`;
  const logColumnWidth = reviewState.isPanelOpen ? "clamp(300px, 32vw, 480px)" : reviewColumnWidth;
  // The terminal is a review-panel view, so "open" is that panel showing it.
  const terminalOpen = reviewState.isPanelOpen && reviewState.layout.modes.includes("terminal");
  const gridStyle = {
    "--session-main-column-min-width": `${CHAT_PANE_MIN_WIDTH_PX}px`,
    "--session-review-panel-width": reviewColumnWidth,
    "--session-log-panel-width": logColumnWidth
  } as CSSProperties;

  // Destructure so the effect's dep is the stable useCallback from inside
  // useReviewState — not the parent object, which would expand the effect's
  // dep audit to the whole review state and trip exhaustive-deps.
  const reviewTogglePanel = reviewState.togglePanel;
  const reviewClosePanel = reviewState.closePanel;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const reviewModes = reviewState.layout.modes;
  const reviewClosePane = reviewState.closePane;
  const reviewOpenBrowser = reviewState.openBrowser;
  const onRightPanelWidthChangeRef = useRef(onRightPanelWidthChange);
  useEffect(() => {
    onRightPanelWidthChangeRef.current = onRightPanelWidthChange;
  }, [onRightPanelWidthChange]);
  // What a grid cell has to reserve for the dock. An automatic width is a
  // share of whatever the cell ends up with, so it reserves the floor: the
  // narrowest the dock can be, which is the width it takes in a cell that
  // small anyway.
  const reservedPanelWidth = pinnedPanelWidth ?? SESSION_RIGHT_PANEL_MIN;
  const dockedRightPanelWidth =
    (reviewIsPanelOpen ? reservedPanelWidth : 0) +
    (isLogOpen ? (reviewIsPanelOpen ? SESSION_LOG_PANEL_MIN : reservedPanelWidth) : 0);
  useEffect(() => {
    onRightPanelWidthChangeRef.current?.(dockedRightPanelWidth > 0 ? dockedRightPanelWidth : null);
  }, [dockedRightPanelWidth]);
  useEffect(
    () => () => {
      onRightPanelWidthChangeRef.current?.(null);
    },
    []
  );

  // A launch row in the transcript opens the subagent in this pane's review
  // panel — the same dock that holds Changes and Files, so delegated work reads
  // beside the work it came from instead of taking a column of the grid.
  // A surface without that dock (the phone) hands the rows no handler, and they
  // read as a record instead of opening a panel that has nowhere to land.
  const openAgentInPanel = reviewState.openAgent;
  const openAgent = useCallback(
    (tool: ToolCall): void => {
      openAgentInPanel(agentTabId(tool));
    },
    [openAgentInPanel]
  );
  const agentsInOverlay = agentsPresentation === "overlay";
  // The overlay keeps its own tab list. `reviewState.openAgent` opens the
  // desktop dock as a side effect, and the phone has no dock to open — routing
  // through it laid the review panel over the chat.
  const overlayTabs = useAgentTabs();
  const overlayCloseAll = overlayTabs.closeAllTabs;
  const overlayOpenTab = overlayTabs.openTab;
  // Whether the peek should be up, and whether it is still on screen. Two
  // states, not one: the intent drives the ride, and presence keeps the sheet
  // mounted until it has gone. Presence is also what the phone's composer
  // floor follows. The floor used to turn back over at the start of the ride
  // out so the native card could rise behind the departing sheet, but that
  // card's return shrinks the web view, and the sheet's ride is measured
  // against the web view's height — it hopped back up a composer's height
  // mid-ride and dropped again, a dark flicker right above the card.
  // Tab count used to stand in for both, so closing wiped the tabs before the
  // sheet could animate.
  const [peekOpen, setPeekOpen] = useState(false);
  const [peekPresent, setPeekPresent] = useState(false);
  const closePeek = useCallback((): void => setPeekOpen(false), []);
  // Navigating away from the chat takes the peek with it: no ride out, since
  // the surface it belongs to is going too.
  const dropPeek = useCallback((): void => {
    setPeekOpen(false);
    setPeekPresent(false);
  }, []);
  useEffect(() => {
    if (!agentsInOverlay) return;
    dropPeek();
    overlayCloseAll();
  }, [agentsInOverlay, dropPeek, overlayCloseAll, sessionId]);
  // Last tab closed from inside the sheet: the peek has nothing left to show.
  const peekTabCount = overlayTabs.tabIds.length;
  useEffect(() => {
    if (!agentsInOverlay || !peekOpen || peekTabCount > 0) return;
    setPeekOpen(false);
  }, [agentsInOverlay, peekOpen, peekTabCount]);
  useEffect(() => {
    if (!agentsInOverlay) return;
    onAgentsOverlayChange?.(peekPresent ? closePeek : null);
    return () => onAgentsOverlayChange?.(null);
  }, [agentsInOverlay, closePeek, onAgentsOverlayChange, peekPresent]);
  // Warm the peek's chunks on idle, the way the terminal's are warmed below:
  // on the phone a launch row is a tap away from the moment the chat opens.
  useEffect(() => {
    if (!agentsInOverlay) return undefined;
    const warm = (): void => {
      void importAgentOverlay().catch(() => undefined);
      void importAgentsView().catch(() => undefined);
    };
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const id = idle(warm);
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(timer);
  }, [agentsInOverlay]);
  const openPeekTab = useCallback(
    (tabId: string): void => {
      overlayOpenTab(tabId);
      setPeekPresent(true);
      setPeekOpen(true);
    },
    [overlayOpenTab]
  );
  const openAgentOverlay = useCallback(
    (tool: ToolCall): void => openPeekTab(agentTabId(tool)),
    [openPeekTab]
  );
  const handleOpenAgent = agentsInOverlay
    ? openAgentOverlay
    : agentsViewAvailable
      ? openAgent
      : undefined;

  // A multitask row opens its chat in the same dock, one tab over from the
  // subagents: both are work running alongside this one.
  // A surface that hands this pane no multitasks has no dock to host them
  // (the phone), and its rows open the chat itself instead.
  const openMultitaskInPanel = reviewState.openMultitask;
  const hostsMultitasks = (multitasks?.length ?? 0) > 0;
  const openMultitaskOverlay = useCallback(
    (sessionId: string): void => openPeekTab(multitaskTabId(sessionId)),
    [openPeekTab]
  );
  const handleOpenMultitask = useMemo(
    () =>
      agentsInOverlay
        ? openMultitaskOverlay
        : hostsMultitasks
          ? openMultitaskInPanel
          : undefined,
    [agentsInOverlay, hostsMultitasks, openMultitaskInPanel, openMultitaskOverlay]
  );

  const handleOpenCommitDialog = useCallback(() => setIsCommitDialogOpen(true), []);
  const handleCloseCommitDialog = useCallback(() => setIsCommitDialogOpen(false), []);
  // Review-panel line comments land on the conversation's composer as diff
  // notes. The conversation owns that state; it registers a sink here so its
  // sibling ReviewPanel can feed it without lifting the state up.
  const annotationSinkRef = useRef<((input: DiffNoteInput) => void) | null>(null);
  const registerAnnotationSink = useCallback(
    (sink: ((input: DiffNoteInput) => void) | null): void => {
      annotationSinkRef.current = sink;
    },
    []
  );
  const handleAddDiffNote = useCallback((input: DiffNoteInput): void => {
    annotationSinkRef.current?.(input);
  }, []);
  const workspaceId = workspace?.id ?? null;
  const handleOpenInIde = useCallback(
    (ide: IdeId): void => {
      if (workspaceId) onOpenWorkspaceInIde?.(workspaceId, ide);
    },
    [onOpenWorkspaceInIde, workspaceId]
  );
  // After a commit the staged/changed set has shifted; refresh the workspace
  // status so the Changes panel updates immediately (the refresh publishes a
  // dashboard delta that bumps changedFilesKey) rather than showing stale rows
  // until the panel is reopened.
  const handleCommitted = useCallback((): void => {
    if (!workspaceId || !window.argmax) return;
    void window.argmax.workspaces.refreshStatus(workspaceId).catch(() => undefined);
  }, [workspaceId]);

  // Warm the heavy xterm chunk on idle once a workspace is present, so the first
  // ⌘J paints the terminal immediately instead of showing blank panel space
  // while the bundle downloads. Deferred to idle so it never competes with the
  // session's own first paint; Vite caches the import, so the real open is instant.
  useEffect(() => {
    if (!workspaceId) return;
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const id = idle(() => void importTerminalView().catch(() => undefined));
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => void importTerminalView().catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [workspaceId]);
  const handleOpenFile = useCallback(
    (path: string, opts?: { line?: number | null; preferIde?: boolean }): void => {
      // A host that owns its own review surface (the mobile shell) routes the
      // tap there instead of opening this pane's ReviewPanel.
      if (onOpenFile) {
        onOpenFile(path, opts);
        return;
      }
      if (opts?.preferIde && workspaceId && window.argmax) {
        void window.argmax.workspaces
          .openInIde({ workspaceId, ide: "default" })
          .catch(() => undefined);
        return;
      }
      if (!workspaceId || !window.argmax) return;
      // Agents reference files in chat by bare basename surprisingly often
      // (e.g. `research_journal.md`); resolving against the workspace tree
      // before opening avoids surfacing an ENOENT panel-error when the file
      // lives in a subdirectory — or doesn't exist at all.
      void resolveOpenablePath(window.argmax, workspaceId, path).then((resolved) => {
        if (resolved) {
          reviewOpenInFilesView(resolved);
          return;
        }
        // Files outside this workspace cannot use its guarded preview. An
        // absolute path can still open in its system-associated application.
        if (path.startsWith("/")) {
          void window.argmax?.system.openPath({ path }).catch(() => undefined);
          return;
        }
        showErrorToast(`Could not find a single ${path} in this workspace.`);
      });
    },
    [onOpenFile, reviewOpenInFilesView, workspaceId]
  );
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);
  const lastDebugLogToggleSignal = useRef(debugLogToggleSignal);

  // Register this pane's file source + pick handler with the command
  // palette when focused. Only the focused pane registers so multiple
  // panes can coexist without fighting over the palette's Files group.
  useEffect(() => {
    if (!registerPaletteFileContext) return undefined;
    if (!isFocused || !workspace) {
      return () => registerPaletteFileContext(null);
    }
    registerPaletteFileContext({
      source: { kind: "workspace", id: workspace.id },
      onPick: reviewOpenInFilesView
    });
    return () => registerPaletteFileContext(null);
  }, [isFocused, workspace, registerPaletteFileContext, reviewOpenInFilesView]);

  useEffect(() => {
    if (rightPanelToggleSignal === lastRightPanelToggleSignal.current) return;
    lastRightPanelToggleSignal.current = rightPanelToggleSignal;
    if (!isFocused) return;
    if (!workspace) return;
    reviewTogglePanel();
  }, [isFocused, reviewTogglePanel, rightPanelToggleSignal, workspace]);

  useEffect(() => {
    if (debugLogToggleSignal === lastDebugLogToggleSignal.current) return;
    lastDebugLogToggleSignal.current = debugLogToggleSignal;
    if (!isFocused) return;
    toggleLog();
  }, [debugLogToggleSignal, isFocused, toggleLog]);

  useEffect(() => {
    if (!isFocused) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (isLogOpen) {
          if (isTypingTarget(event.target)) return;
          event.preventDefault();
          setIsLogOpen(false);
          return;
        }
        if (reviewIsPanelOpen) {
          if (isTypingTarget(event.target)) return;
          event.preventDefault();
          reviewClosePanel();
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      // ⌘⇧I toggles the browser the way ⌘G toggles Files: open it in this
      // pane's panel, or close just the browser half of a split.
      if (event.shiftKey) {
        if (key !== "i" || !window.argmax?.browser) return;
        event.preventDefault();
        if (reviewIsPanelOpen && reviewModes.includes("browser")) {
          reviewClosePane(reviewModes[0] === "browser" ? 0 : 1);
        } else {
          reviewOpenBrowser();
        }
        return;
      }
      if (key === "b") {
        event.preventDefault();
        reviewTogglePanel();
        return;
      }
      if (key === "g") {
        event.preventDefault();
        if (reviewIsPanelOpen && reviewModes.includes("files")) {
          reviewClosePane(reviewModes[0] === "files" ? 0 : 1);
        } else {
          reviewOpenPanelInFilesMode();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    isFocused,
    isLogOpen,
    reviewClosePanel,
    reviewIsPanelOpen,
    reviewModes,
    reviewClosePane,
    reviewOpenBrowser,
    reviewOpenPanelInFilesMode,
    reviewTogglePanel
  ]);

  // Until the backfill below lands, the transcript is whatever was left over
  // from the last time this session was open — an unselected session is
  // unsubscribed and receives no events at all. The conversation measures its
  // restore window (entrance motion, typed reveal) from this rather than from
  // mount, so a slow backfill can't arrive looking like new activity.
  const [eventsBackfilled, setEventsBackfilled] = useState(false);
  // Backfill timeline events for this pane on mount and whenever the session
  // changes. Each pane backfills independently of the focused-pane selection,
  // so non-focused panes still stream live messages. `loadSessionEvents` is
  // sessionId-keyed and uses a cursor map, so concurrent callers are safe.
  useEffect(() => {
    if (!sessionId || !onLoadSessionEvents) {
      setEventsBackfilled(true);
      return;
    }
    setEventsBackfilled(false);
    let cancelled = false;
    // Settle on failure too: a pane stuck mid-restore would never animate or
    // type again, which is a worse failure than the one being fixed.
    void onLoadSessionEvents(sessionId).finally(() => {
      if (!cancelled) setEventsBackfilled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onLoadSessionEvents]);

  // Captures the listener-removal + body-style-reset for any drag currently
  // in flight; the unmount cleanup below replays it so a mid-drag unmount
  // doesn't leave document-level listeners or a frozen cursor behind.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  const startPanelResize = useCallback(
    (event: ReactMouseEvent, dock: "left" | "right"): void => {
      event.preventDefault();
      dragCleanupRef.current?.();
      const startX = event.clientX;
      // Measure the panel the handle sits in rather than reading the stored
      // width: on an automatic width there is no stored number, and the drag
      // has to start from what the user can see.
      const panel = event.currentTarget.parentElement;
      const startWidth = panel
        ? Math.round(panel.getBoundingClientRect().width)
        : SESSION_RIGHT_PANEL_MIN;
      let pinned = startWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      setIsPanelResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (e: MouseEvent): void => {
        // The handle sits on the panel's inner edge, so dragging away from the
        // dock side widens it: right-docked grows leftwards, left-docked grows
        // rightwards.
        const delta = e.clientX - startX;
        const next = Math.round(
          Math.max(
            SESSION_RIGHT_PANEL_MIN,
            Math.min(SESSION_RIGHT_PANEL_MAX, dock === "left" ? startWidth + delta : startWidth - delta)
          )
        );
        pinned = next;
        setPinnedPanelWidth(next);
      };
      const cleanup = (): void => {
        // Written once the drag settles: a width the user chose, which from
        // here on outranks the automatic share.
        if (pinned !== startWidth) writePinnedPanelWidth(pinned);
        setIsPanelResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("blur", cleanup);
        dragCleanupRef.current = null;
      };
      const onMouseUp = (): void => cleanup();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      window.addEventListener("blur", cleanup);
      dragCleanupRef.current = cleanup;
    },
    []
  );

  // Read the dock side at mousedown so a setting change mid-session takes
  // effect on the next drag without threading the value through props.
  const onReviewPanelResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => startPanelResize(event, readStoredReviewPanelSide()),
    [startPanelResize]
  );

  // The debug log panel is always right-docked, whatever the review panel does.
  const onLogPanelResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => startPanelResize(event, "right"),
    [startPanelResize]
  );

  return (
    <div
      className={gridClass}
      style={gridStyle}
      data-panel-resizing={isPanelResizing ? "true" : undefined}
    >
      {isPanelResizing ? (
        <div className="session-panel-resize-shield" data-browser-overlay="true" aria-hidden="true" />
      ) : null}
      <div className="session-main-column">
        <SessionConversation
          isFocused={isFocused}
          chatFontSize={chatFontSize}
          checks={checks}
          defaultToolCallsDisplay={defaultToolCallsDisplay}
          defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
          thinkingDisplay={thinkingDisplay}
          defaultTurnChangesExpanded={defaultTurnChangesExpanded}
          defaultFollowUpDelivery={defaultFollowUpDelivery}
          events={visibleEvents}
          eventsBackfilled={eventsBackfilled}
          fastModeEnabled={fastModeEnabled}
          isLogOpen={isLogOpen}
          onClose={onClose}
          onFastModeEnabledChange={onFastModeEnabledChange}
          onNewSession={onNewSession}
          onOpenSideChat={onOpenSideChat}
          onOpenSession={onOpenSession}
          onOpenDetails={onOpenDetails}
          defaultIde={defaultIde}
          detectedIdes={detectedIdes}
          onOpenInIde={handleOpenInIde}
          onOpenCommitDialog={handleOpenCommitDialog}
          registerAnnotationSink={registerAnnotationSink}
          onSendSessionInput={onSendSessionInput}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onSendQueuedMessageNow={onSendQueuedMessageNow}
          onMultitask={onMultitask}
          pendingMessages={sessionId ? (pendingMessages?.[sessionId] ?? []) : []}
          onTerminateSession={onTerminateSession}
          onClearSession={onClearSession}
          onForkSession={onForkSession}
          onRunCheck={onRunCheck}
          onOpenFile={handleOpenFile}
          onOpenDiff={onOpenFile ? handleOpenFile : undefined}
          onOpenChanges={onOpenChanges}
          onOpenAgent={handleOpenAgent}
          onOpenMultitask={handleOpenMultitask}
          multitasks={multitasks}
          onToggleLog={toggleLog}
          isTerminalOpen={terminalOpen}
          onToggleTerminal={reviewState.toggleTerminal}
          workspaceCardEnabled={workspaceCardVisible}
          onHideWorkspaceCard={handleHideWorkspaceCard}
          onToggleWorkspaceCard={handleToggleWorkspaceCard}
          project={project}
          rawOutputs={visibleRawOutputs}
          review={reviewState}
          session={session}
          workspace={workspace}
          contextIndicatorEnabled={contextIndicatorEnabled}
          goalEnabled={goalEnabled}
          goalMaxTurns={goalMaxTurns}
          nativeComposerFloor={nativeComposerFloor}
          revertEnabled={revertEnabled}
        />

        <ApprovalSurface
          approvals={visibleApprovals}
          events={visibleEvents}
          onResolveApproval={onResolveApproval}
        />
      {agentsInOverlay && peekPresent ? (
        <Suspense fallback={null}>
          <AgentOverlay
            label="Delegated work"
            open={peekOpen}
            awaitsFloorChange={nativeComposerFloor}
            onClose={closePeek}
            onExited={() => setPeekPresent(false)}
          >
            <AgentsView
              chatFontSize={chatFontSize}
              events={visibleEvents}
              stripLimit={2}
              defaultToolCallsDisplay={defaultToolCallsDisplay}
              defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
              thinkingDisplay={thinkingDisplay}
              isFocused={isFocused}
              parentSession={session}
              agentTabs={overlayTabs}
              workspace={workspace}
              onLoadAgentEvents={onLoadAgentEvents}
              onLoadSessionEvents={onLoadSessionEvents}
              onOpenAgent={handleOpenAgent}
              onOpenFile={handleOpenFile}
              // A multitask's changed-file rows and its Review button open the
              // containing dock's Changes view on the desktop. The phone has no
              // dock, so they take the same way in as a file reference tapped in
              // the transcript: the host's review screen. Both land on this
              // pane's workspace, which is the checkout a multitask shares by
              // default — the desktop dock scopes them the same way.
              onOpenDiff={handleOpenFile}
              onOpenReview={onOpenChanges}
              multitasks={multitasks}
              pendingMessages={pendingMessages}
              onCancelQueuedMessage={onCancelQueuedMessage}
              onClearSession={onClearSession}
              onOpenFullChat={
                onOpenSession
                  ? (sessionId) => {
                      dropPeek();
                      overlayCloseAll();
                      onOpenSession(sessionId);
                    }
                  : undefined
              }
              onSendQueuedMessageNow={onSendQueuedMessageNow}
              onSendSessionInput={onSendSessionInput}
              onTerminateSession={onTerminateSession}
            />
          </AgentOverlay>
        </Suspense>
      ) : null}
      </div>
      {reviewState.isPanelOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel
            agents={{
              events: visibleEvents,
              defaultToolCallsDisplay,
              defaultToolCallGroupsExpanded,
              thinkingDisplay,
              parentSession: session,
              workspace,
              onLoadAgentEvents,
              onLoadSessionEvents,
              onOpenAgent: handleOpenAgent,
              multitasks,
              pendingMessages,
              onCancelQueuedMessage,
              onClearSession,
              onOpenFullChat: onOpenSession,
              onSendQueuedMessageNow,
              onSendSessionInput,
              onTerminateSession
            }}
            review={reviewState}
            isFocused={isFocused}
            onAddDiffNote={session ? handleAddDiffNote : undefined}
            onResizePanelMouseDown={onReviewPanelResizeMouseDown}
          />
        </Suspense>
      ) : null}
      {workspace ? (
        <CommitDialog
          open={isCommitDialogOpen}
          onClose={handleCloseCommitDialog}
          onCommitted={handleCommitted}
          workspaceId={workspace.id}
          files={reviewState.files}
          defaultMessage={workspace.taskLabel}
        />
      ) : null}
      {isLogOpen ? (
        <DebugPanel
          events={visibleEvents}
          rawOutputs={visibleRawOutputs}
          session={session}
          workspace={workspace}
          onClose={() => setIsLogOpen(false)}
          onResizePanelMouseDown={reviewState.isPanelOpen ? undefined : onLogPanelResizeMouseDown}
        />
      ) : null}
    </div>
  );
}
