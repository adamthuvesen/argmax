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
  type MouseEvent as ReactMouseEvent,
} from "react";
import { FileDiff, FolderTree, Globe } from "lucide-react";
import {
  bridgeAvailable,
  browserActions,
  resolveFileForOpening,
  systemActions,
  workspaceActions,
} from "../data/bridgeActions.js";
import type { ReviewSideChatContext } from "./ReviewSideChat.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { QueuedMessageDelivery } from "../../shared/types.js";
import type { SendInputResult } from "../../shared/bindings.js";
import type { NewSessionSeed } from "./SessionComposer.js";
import type { DiffNoteInput } from "../lib/composerAnnotations.js";
import type { MultitaskChild } from "../lib/multitask.js";
import type {
  PaletteItem,
  PaletteSurfaceContext,
  PaletteSurfaceLive,
} from "../lib/paletteSearch.js";
import type {
  AgentMode,
  AgentReference,
  ApprovalRequest,
  CheckRun,
  ComposerAttachment,
  DetectedIde,
  ForkSessionOptions,
  IdeId,
  NativeAgentIdentity,
  PendingMessage,
  ProjectSummary,
  ProviderId,
  SessionSummary,
  WorkspaceSummary,
} from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import type { FontSize } from "../lib/fonts.js";
import { useSessionTimeline } from "../hooks/useSessionTimeline.js";
import { CHAT_PANE_MIN_WIDTH_PX } from "../lib/layoutConstants.js";
import { useStableFilter } from "../hooks/useStableFilter.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { showErrorToast } from "../state/toast.js";
import { readStoredReviewPanelSide } from "../lib/reviewPanelSide.js";
import { buildSessionToolCalls } from "../lib/sessionConversationModel.js";
import {
  ESCAPE_STOPS_CHAT_KEY,
  readBooleanPreference,
  readBoundedNumberPreference,
  type FollowUpDelivery,
  type ThinkingDisplay,
  type ToolCallsDisplay,
} from "../lib/uiPreferences.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { agentTabId } from "../lib/agentTabs.js";
import { importChunk } from "../lib/importChunk.js";
import { ApprovalSurface } from "./ApprovalSurface.js";
import { DebugPanel } from "./debug/DebugPanel.js";
// ReviewPanel lazy-mounted (ralph B4); Vite emits a single ReviewPanel-*
// chunk shared with the LaunchSurface call site.
// The phone's peek at delegated work. Lazy for the same reason ReviewPanel is:
// most sessions never open one. Named imports so a surface that *can* raise
// the peek warms them on idle — a lazy chunk fetched on the tap paints an
// empty sheet for as long as it takes to arrive.
const ReviewPanel = lazy(() =>
  importChunk(async () => ({
    default: (await import("./ReviewPanel.js")).ReviewPanel,
  })),
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

function isEditorEscapeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm, .cm-editor") !== null;
}

/** The unlaunched side-chat prompt lives only in the mounted review panel, so
 *  Escape there must not close the panel even in the expanded view. */
function isSideChatComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".review-side-chat-composer") !== null;
}

function hasActiveDialog(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(
    (dialog) => dialog.getAttribute("aria-hidden") !== "true",
  );
}

/** Null when the user has never dragged the handle, which leaves the dock on
 *  `SESSION_RIGHT_PANEL_AUTO_WIDTH` instead of freezing it at a stored width. */
function readPinnedPanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  if (window.localStorage.getItem(SESSION_RIGHT_PANEL_WIDTH_KEY) === null) return null;
  return readBoundedNumberPreference(SESSION_RIGHT_PANEL_WIDTH_KEY, {
    min: SESSION_RIGHT_PANEL_MIN,
    max: SESSION_RIGHT_PANEL_MAX,
    fallback: SESSION_RIGHT_PANEL_MIN,
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
  onOpenSideChat,
  sideChat,
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
  workspaceCardVisible = true,
  onWorkspaceCardVisibleChange,
  contextIndicatorEnabled = false,
  workspace,
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
  onFastModeEnabledChange?: (enabled: boolean) => void;
  /** Called on mount and on session.id change to backfill timeline events for this pane's session. */
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  /** Backfills one subagent's child rows, for the review panel's Agents view. */
  onLoadAgentEvents?: (
    sessionId: string,
    parentToolUseId: string,
    identity?: NativeAgentIdentity,
  ) => Promise<void | { hasMore: boolean }>;
  /** Opens a launcher pane beside this one. Absent outside the grid. */
  onNewSession?: (seed?: NewSessionSeed) => void;
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  sideChat?: ReviewSideChatContext;
  onOpenSession?: (sessionId: string) => void;
  onOpenDetails?: (seedPrompt: string, context?: { attachToChat?: () => void }) => Promise<void>;
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
    delivery?: FollowUpDelivery,
  ) => Promise<SendInputResult>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow: (
    sessionId: string,
    messageId: string,
    delivery?: QueuedMessageDelivery,
  ) => Promise<void>;
  onMultitask?: (
    sessionId: string,
    prompt: string,
    provider: ProviderId,
    pendingMessageId?: string,
  ) => Promise<void>;
  /** Multitasks dispatched from this pane's session. They have no sidebar row
   *  of their own — this pane's dock is where they are read and answered. */
  multitasks?: MultitaskChild[];
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onForkSession?: (sessionId: string, options?: ForkSessionOptions) => Promise<void>;
  project: ProjectSummary | null;
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  session: SessionSummary | null;
  /** Whether this surface has a dock to host the Agents view. False on the
      phone, where a launch row is a record of the delegated work, not a way in. */
  agentsViewAvailable?: boolean;
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
  registerPaletteFileContext?: (context: PaletteSurfaceContext | null) => void;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  // Wrap in useMemo so the hook's source identity is stable between renders —
  // otherwise a fresh object every render would invalidate downstream deps.
  const reviewSource = useMemo<ReviewSource | null>(
    () => (workspace ? { kind: "workspace", workspace } : null),
    [workspace],
  );
  const visibleApprovals = useStableFilter(
    approvals,
    sessionId,
    (approval) => approval.sessionId === sessionId,
  );
  const { events: visibleEvents, rawOutputs: visibleRawOutputs } = useSessionTimeline(sessionId);
  const cursorBackgroundAgentIds = useMemo(() => {
    if (session?.provider !== "cursor") return [];
    return buildSessionToolCalls(
      visibleEvents,
      session.state === "running",
      session.state === "failed" || session.state === "cancelled",
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
  const reviewState = useReviewState(reviewSource, {
    claimsBrowserRequests: isFocused,
    preloadChanges: isFocused,
    sessionId,
  });
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isReviewExpanded, setIsReviewExpanded] = useState(false);
  useEffect(() => {
    if (!reviewState.isPanelOpen) setIsReviewExpanded(false);
  }, [reviewState.isPanelOpen, sessionId]);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const escapeTerminationPendingRef = useRef<object | null>(null);
  // Null while the dock is on its automatic share of the pane; a pixel width
  // once the user has dragged the handle.
  const [pinnedPanelWidth, setPinnedPanelWidth] = useState<number | null>(readPinnedPanelWidth);
  const toggleLog = useCallback(() => setIsLogOpen((v) => !v), []);
  // The card's own dismiss and the session menu's checkbox write the same
  // app-level preference, so hiding it here keeps it hidden everywhere.
  const handleHideWorkspaceCard = useCallback(
    () => onWorkspaceCardVisibleChange?.(false),
    [onWorkspaceCardVisibleChange],
  );
  const handleToggleWorkspaceCard = useCallback(
    () => onWorkspaceCardVisibleChange?.(!workspaceCardVisible),
    [onWorkspaceCardVisibleChange, workspaceCardVisible],
  );
  const gridClass = [
    "session-grid",
    reviewState.isPanelOpen && "review-open",
    reviewState.isPanelOpen && isReviewExpanded && "review-expanded",
    isLogOpen && "log-open",
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
    "--session-log-panel-width": logColumnWidth,
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
    [],
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
    [openAgentInPanel],
  );
  const handleOpenAgent = agentsViewAvailable ? openAgent : undefined;

  // A multitask row opens its chat in the same dock, one tab over from the
  // subagents: both are work running alongside this one.
  // A surface that hands this pane no multitasks has no dock to host them
  // (the phone), and its rows open the chat itself instead.
  const openMultitaskInPanel = reviewState.openMultitask;
  const hostsMultitasks = (multitasks?.length ?? 0) > 0;
  const handleOpenMultitask = hostsMultitasks ? openMultitaskInPanel : undefined;

  // Review-panel line comments land on the conversation's composer as diff
  // notes. The conversation owns that state; it registers a sink here so its
  // sibling ReviewPanel can feed it without lifting the state up.
  const annotationSinkRef = useRef<((input: DiffNoteInput) => void) | null>(null);
  const registerAnnotationSink = useCallback(
    (sink: ((input: DiffNoteInput) => void) | null): void => {
      annotationSinkRef.current = sink;
    },
    [],
  );
  const handleAddDiffNote = useCallback((input: DiffNoteInput): void => {
    annotationSinkRef.current?.(input);
  }, []);
  const workspaceId = workspace?.id ?? null;
  const handleOpenInIde = useCallback(
    (ide: IdeId): void => {
      if (workspaceId) onOpenWorkspaceInIde?.(workspaceId, ide);
    },
    [onOpenWorkspaceInIde, workspaceId],
  );
  // Warm the heavy xterm chunk on idle once a workspace is present, so the first
  // ⌘J paints the terminal immediately instead of showing blank panel space
  // while the bundle downloads. Deferred to idle so it never competes with the
  // session's own first paint; Vite caches the import, so the real open is instant.
  useEffect(() => {
    if (!workspaceId) return;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => void importTerminalView().catch(() => undefined));
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => void importTerminalView().catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [workspaceId]);
  const handleOpenFile = useCallback(
    (path: string, opts?: { line?: number | null; preferIde?: boolean }): void => {
      const workspaces = workspaceActions();
      if (opts?.preferIde && workspaceId && workspaces) {
        void workspaces
          .openInIde({ workspaceId, ide: "default" })
          .catch((error: unknown) =>
            showErrorToast(error instanceof Error ? error.message : "Could not open the editor."),
          );
        return;
      }
      if (!workspaceId || !bridgeAvailable()) return;
      // Agents reference files in chat by bare basename surprisingly often
      // (e.g. `research_journal.md`); resolving against the workspace tree
      // before opening avoids surfacing an ENOENT panel-error when the file
      // lives in a subdirectory — or doesn't exist at all.
      void resolveFileForOpening(workspaceId, path).then((resolved) => {
        if (resolved) {
          reviewOpenInFilesView(resolved);
          return;
        }
        // Files outside this workspace cannot use its guarded preview. An
        // absolute path can still open in its system-associated application.
        if (path.startsWith("/")) {
          void systemActions()
            ?.openPath({ path })
            .catch((error: unknown) => {
              showErrorToast(error instanceof Error ? error.message : "Could not open the file.");
            });
          return;
        }
        showErrorToast(`Could not find a single ${path} in this workspace.`);
      });
    },
    [reviewOpenInFilesView, workspaceId],
  );
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);
  const lastDebugLogToggleSignal = useRef(debugLogToggleSignal);

  // ⌘G and ⌘⇧I, shared with the palette rows that name them.
  const toggleFilesPane = useCallback((): void => {
    if (reviewIsPanelOpen && reviewModes.includes("files")) {
      reviewClosePane(reviewModes[0] === "files" ? 0 : 1);
    } else {
      reviewOpenPanelInFilesMode();
    }
  }, [reviewClosePane, reviewIsPanelOpen, reviewModes, reviewOpenPanelInFilesMode]);
  const toggleBrowserPane = useCallback((): void => {
    if (reviewIsPanelOpen && reviewModes.includes("browser")) {
      reviewClosePane(reviewModes[0] === "browser" ? 0 : 1);
    } else {
      reviewOpenBrowser();
    }
  }, [reviewClosePane, reviewIsPanelOpen, reviewModes, reviewOpenBrowser]);

  // What the palette reads about this pane when it opens. Rebuilt as a
  // closure each render so the read is current without re-registering.
  const paletteLiveRef = useRef<() => PaletteSurfaceLive>(() => ({
    filesVisible: false,
    changedPaths: [],
    actions: [],
  }));
  paletteLiveRef.current = (): PaletteSurfaceLive => {
    const actions: PaletteItem[] = [
      {
        id: "pane:toggle-files",
        label: "Toggle files",
        subtitle: "Browse this checkout",
        group: "Actions",
        icon: FolderTree,
        shortcut: "⌘G",
        keywords: ["file tree", "explorer"],
        run: toggleFilesPane,
      },
      {
        id: "pane:toggle-changes",
        label: "Toggle changes",
        subtitle: "This chat's diff",
        group: "Actions",
        icon: FileDiff,
        keywords: ["diff", "review", "git status"],
        run: reviewState.toggleChangesPanel,
      },
      ...(browserActions()
        ? [
            {
              id: "pane:toggle-browser",
              label: "Toggle browser panel",
              subtitle: "A browser beside the chat",
              group: "Actions" as const,
              icon: Globe,
              shortcut: "⌘⇧I",
              keywords: ["web", "preview", "localhost"],
              run: toggleBrowserPane,
            },
          ]
        : []),
    ];
    return {
      filesVisible:
        reviewIsPanelOpen && (reviewModes.includes("files") || reviewModes.includes("changes")),
      changedPaths: reviewState.files.map((file) => file.path),
      actions,
    };
  };
  const readPaletteLive = useCallback((): PaletteSurfaceLive => paletteLiveRef.current(), []);

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
      onPick: reviewOpenInFilesView,
      readLive: readPaletteLive,
    });
    return () => registerPaletteFileContext(null);
  }, [isFocused, workspace, registerPaletteFileContext, reviewOpenInFilesView, readPaletteLive]);

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
    escapeTerminationPendingRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!isFocused) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (
          event.defaultPrevented ||
          event.isComposing ||
          event.repeat ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          (isReviewExpanded
            ? isSideChatComposerTarget(event.target)
            : isEditorEscapeTarget(event.target)) ||
          hasActiveDialog()
        )
          return;
        if (isLogOpen && !isReviewExpanded) {
          event.preventDefault();
          setIsLogOpen(false);
          return;
        }
        if (reviewIsPanelOpen) {
          event.preventDefault();
          reviewClosePanel();
          return;
        }
        if (
          session?.state !== "running" ||
          !readBooleanPreference(ESCAPE_STOPS_CHAT_KEY, false) ||
          escapeTerminationPendingRef.current !== null
        )
          return;
        event.preventDefault();
        const terminationRequest = {};
        escapeTerminationPendingRef.current = terminationRequest;
        const clearPending = (): void => {
          if (escapeTerminationPendingRef.current === terminationRequest) {
            escapeTerminationPendingRef.current = null;
          }
        };
        void onTerminateSession(session.id).then(clearPending, clearPending);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      // ⌘⇧I toggles the browser the way ⌘G toggles Files: open it in this
      // pane's panel, or close just the browser half of a split.
      if (event.shiftKey) {
        if (key !== "i" || !browserActions()) return;
        event.preventDefault();
        toggleBrowserPane();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        reviewTogglePanel();
        return;
      }
      if (key === "g") {
        event.preventDefault();
        toggleFilesPane();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isFocused,
    isLogOpen,
    isReviewExpanded,
    onTerminateSession,
    reviewClosePanel,
    reviewIsPanelOpen,
    reviewTogglePanel,
    session,
    toggleBrowserPane,
    toggleFilesPane,
  ]);

  // Until the backfill below lands, the transcript is whatever was left over
  // from the last time this session was open — an unselected session is
  // unsubscribed and receives no events at all. The conversation measures its
  // restore window (entrance motion, typed reveal) from this rather than from
  // mount, so a slow backfill can't arrive looking like new activity.
  const [eventsBackfilled, setEventsBackfilled] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [historyRetryKey, setHistoryRetryKey] = useState(0);
  const retryHistoryLoad = useCallback(() => {
    setHistoryLoadFailed(false);
    setHistoryRetryKey((key) => key + 1);
  }, []);
  // Backfill timeline events for this pane on mount and whenever the session
  // changes. Each pane backfills independently of the focused-pane selection,
  // so non-focused panes still stream live messages. `loadSessionEvents` is
  // sessionId-keyed and uses a cursor map, so concurrent callers are safe.
  useEffect(() => {
    if (!sessionId || !onLoadSessionEvents) {
      setHistoryLoadFailed(false);
      setEventsBackfilled(true);
      return;
    }
    setEventsBackfilled(false);
    setHistoryLoadFailed(false);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number): void => {
      void Promise.resolve()
        .then(() => onLoadSessionEvents(sessionId))
        .then(
          () => {
            if (!cancelled) setEventsBackfilled(true);
          },
          () => {
            if (cancelled) return;
            if (attempt < 3) {
              retryTimer = setTimeout(() => load(attempt + 1), attempt * 300);
            } else {
              setHistoryLoadFailed(true);
            }
          },
        );
    };
    load(1);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId, onLoadSessionEvents, historyRetryKey]);

  // Captures the listener-removal + body-style-reset for any drag currently
  // in flight; the unmount cleanup below replays it so a mid-drag unmount
  // doesn't leave document-level listeners or a frozen cursor behind.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    [],
  );

  const startPanelResize = useCallback((event: ReactMouseEvent, dock: "left" | "right"): void => {
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
          Math.min(
            SESSION_RIGHT_PANEL_MAX,
            dock === "left" ? startWidth + delta : startWidth - delta,
          ),
        ),
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
  }, []);

  // Read the dock side at mousedown so a setting change mid-session takes
  // effect on the next drag without threading the value through props.
  const onReviewPanelResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => startPanelResize(event, readStoredReviewPanelSide()),
    [startPanelResize],
  );

  // The debug log panel is always right-docked, whatever the review panel does.
  const onLogPanelResizeMouseDown = useCallback(
    (event: ReactMouseEvent): void => startPanelResize(event, "right"),
    [startPanelResize],
  );

  return (
    <div
      className={gridClass}
      style={gridStyle}
      data-panel-resizing={isPanelResizing ? "true" : undefined}
    >
      {isPanelResizing ? (
        <div
          className="session-panel-resize-shield"
          data-testid="session-panel-resize-shield"
          data-browser-overlay="true"
          aria-hidden="true"
        />
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
          historyLoadFailed={historyLoadFailed}
          onRetryHistoryLoad={retryHistoryLoad}
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
          onOpenAgent={handleOpenAgent}
          onOpenMultitask={handleOpenMultitask}
          onLoadSessionEvents={onLoadSessionEvents}
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
          revertEnabled={revertEnabled}
        />

        <ApprovalSurface
          approvals={visibleApprovals}
          events={visibleEvents}
          onResolveApproval={onResolveApproval}
        />
      </div>
      {reviewState.isPanelOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel
            sideChat={sideChat}
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
              onTerminateSession,
            }}
            review={reviewState}
            isFocused={isFocused}
            onAddDiffNote={session ? handleAddDiffNote : undefined}
            isExpanded={isReviewExpanded}
            onToggleExpanded={() => setIsReviewExpanded((expanded) => !expanded)}
            onResizePanelMouseDown={isReviewExpanded ? undefined : onReviewPanelResizeMouseDown}
          />
        </Suspense>
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
