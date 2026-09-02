import { ShieldAlert } from "lucide-react";
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
import type { NewSessionSeed } from "./SessionComposer.js";
import type { ReviewCommentInput } from "../lib/composerAnnotations.js";
import type {
  AgentMode,
  ApprovalRequest,
  CheckRun,
  ComposerAttachment,
  DetectedIde,
  IdeId,
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { CHAT_PANE_MIN_WIDTH_PX } from "../lib/layoutConstants.js";
import { useStableFilter } from "../hooks/useStableFilter.js";
import { lastTurnEditedPaths } from "../lib/lastTurnFiles.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import { readStoredReviewPanelSide } from "../lib/reviewPanelSide.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { readBoundedNumberPreference, type ToolCallsDisplay } from "../lib/uiPreferences.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { CommitDialog } from "./CommitDialog.js";
import { DebugPanel } from "./debug/DebugPanel.js";
// ReviewPanel lazy-mounted (ralph B4); Vite emits a single ReviewPanel-*
// chunk shared with the LaunchSurface call site.
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel.js")).ReviewPanel
}));
import { SessionConversation } from "./SessionConversation.js";
// TerminalTabsPanel pulls in @xterm/xterm + addons + xterm CSS — heavy and
// only loaded when the user opens the review panel's Terminal view, which
// mounts it. Named here so this pane can prefetch the chunk on idle (see the
// warm-up effect below) and the first ⌘J paints straight away.
const importTerminalView = () => import("./TerminalTabsPanel.js");

const SESSION_RIGHT_PANEL_WIDTH_KEY = "argmax.session.rightPanel.width";
const SESSION_RIGHT_PANEL_MIN = 360;
const SESSION_RIGHT_PANEL_MAX = 2000;
const SESSION_RIGHT_PANEL_DEFAULT = 420;
const SESSION_LOG_PANEL_MIN = 300;

export function SessionPane({
  approvals,
  checks,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  defaultTurnChangesExpanded,
  events,
  fastModeEnabled = false,
  isFocused = true,
  onClose,
  onFastModeEnabledChange,
  onLoadAgentEvents,
  onLoadSessionEvents,
  onNewSession,
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
  pendingMessages,
  onTerminateSession,
  onClearSession,
  onForkSession,
  project,
  rawOutputs,
  registerPaletteFileContext,
  rightPanelToggleSignal,
  debugLogToggleSignal,
  session,
  workspaceCardVisible = true,
  onWorkspaceCardVisibleChange,
  workspace
}: {
  approvals: ApprovalRequest[];
  checks?: CheckRun[];
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  defaultTurnChangesExpanded?: boolean;
  events: TimelineEvent[];
  fastModeEnabled?: boolean;
  /** When false, the pane skips its document-level keyboard shortcuts so only the focused pane reacts. */
  isFocused?: boolean;
  /** Close button is shown when provided. Used by the multi-pane grid; absent in single-pane mode. */
  onClose?: () => void;
  onOpenFile?: (path: string, opts?: { line?: number | null; preferIde?: boolean }) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  /** Called on mount and on session.id change to backfill timeline events for this pane's session. */
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  /** Backfills one subagent's child rows, for the review panel's Agents view. */
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
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
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow: (sessionId: string, messageId: string) => Promise<void>;
  onMultitask?: (sessionId: string, prompt: string) => Promise<void>;
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onForkSession?: (sessionId: string) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  session: SessionSummary | null;
  /** User preference for the floating workspace card. The pane still hides it
      whenever a right-hand panel is docked. */
  workspaceCardVisible?: boolean;
  onWorkspaceCardVisibleChange?: (visible: boolean) => void;
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
  // Stable per-session slices: a delta for another session leaves these
  // identity-equal, so the conversation's derived memos and memoized turns skip
  // work instead of re-deriving on every unrelated delta (matters most in the
  // multi-pane grid).
  const visibleApprovals = useStableFilter(approvals, sessionId, (approval) => approval.sessionId === sessionId);
  const visibleEvents = useStableFilter(events, sessionId, (event) => event.sessionId === sessionId);
  const visibleRawOutputs = useStableFilter(rawOutputs, sessionId, (output) => output.sessionId === sessionId);
  // Which files the agent wrote in its newest turn, for the review panel's
  // "Last turn" scope. Null without a session: there is no turn to scope to.
  const lastTurnPaths = useMemo(() => lastTurnEditedPaths(visibleEvents), [visibleEvents]);
  const reviewState = useReviewState(reviewSource, session ? lastTurnPaths : null, {
    claimsBrowserRequests: isFocused,
    sessionId
  });
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() =>
    readBoundedNumberPreference(SESSION_RIGHT_PANEL_WIDTH_KEY, {
      min: SESSION_RIGHT_PANEL_MIN,
      max: SESSION_RIGHT_PANEL_MAX,
      fallback: SESSION_RIGHT_PANEL_DEFAULT
    })
  );
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
  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    try {
      await onResolveApproval(approvalId, status);
    } catch {
      // Errors are surfaced through the parent toast system.
    }
  };

  const gridClass = [
    "session-grid",
    reviewState.isPanelOpen && "review-open",
    isLogOpen && "log-open"
  ]
    .filter(Boolean)
    .join(" ");
  const reviewColumnWidth = `${rightPanelWidth}px`;
  const logColumnWidth = reviewState.isPanelOpen ? "clamp(300px, 32vw, 480px)" : `${rightPanelWidth}px`;
  // The terminal is a review-panel view, so "open" is that panel showing it.
  const terminalOpen = reviewState.isPanelOpen && reviewState.mode === "terminal";
  const gridStyle = {
    "--session-main-column-min-width": `${CHAT_PANE_MIN_WIDTH_PX}px`,
    "--session-review-panel-width": reviewColumnWidth,
    "--session-log-panel-width": logColumnWidth
  } as CSSProperties;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SESSION_RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  // Destructure so the effect's dep is the stable useCallback from inside
  // useReviewState — not the parent object, which would expand the effect's
  // dep audit to the whole review state and trip exhaustive-deps.
  const reviewTogglePanel = reviewState.togglePanel;
  const reviewClosePanel = reviewState.closePanel;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const reviewMode = reviewState.mode;
  const onRightPanelWidthChangeRef = useRef(onRightPanelWidthChange);
  useEffect(() => {
    onRightPanelWidthChangeRef.current = onRightPanelWidthChange;
  }, [onRightPanelWidthChange]);
  const dockedRightPanelWidth =
    (reviewIsPanelOpen ? rightPanelWidth : 0) +
    (isLogOpen ? (reviewIsPanelOpen ? SESSION_LOG_PANEL_MIN : rightPanelWidth) : 0);
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
  const openAgentInPanel = reviewState.openAgent;
  const handleOpenAgent = useCallback(
    (tool: ToolCall): void => {
      openAgentInPanel(tool.toolUseId);
    },
    [openAgentInPanel]
  );

  const handleOpenCommitDialog = useCallback(() => setIsCommitDialogOpen(true), []);
  const handleCloseCommitDialog = useCallback(() => setIsCommitDialogOpen(false), []);
  // Review-panel line comments land on the conversation's composer as
  // annotations. The conversation owns that state; it registers a sink here
  // so its sibling ReviewPanel can feed it without lifting the state up.
  const annotationSinkRef = useRef<((input: ReviewCommentInput) => void) | null>(null);
  const registerAnnotationSink = useCallback(
    (sink: ((input: ReviewCommentInput) => void) | null): void => {
      annotationSinkRef.current = sink;
    },
    []
  );
  const handleAddReviewComment = useCallback((input: ReviewCommentInput): void => {
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
        if (resolved) reviewOpenInFilesView(resolved);
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
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        reviewTogglePanel();
        return;
      }
      if (key === "g") {
        event.preventDefault();
        if (reviewIsPanelOpen && reviewMode === "files") {
          reviewClosePanel();
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
    reviewMode,
    reviewOpenPanelInFilesMode,
    reviewTogglePanel
  ]);

  // Backfill timeline events for this pane on mount and whenever the session
  // changes. Each pane backfills independently of the focused-pane selection,
  // so non-focused panes still stream live messages. `loadSessionEvents` is
  // sessionId-keyed and uses a cursor map, so concurrent callers are safe.
  useEffect(() => {
    if (!sessionId || !onLoadSessionEvents) return;
    void onLoadSessionEvents(sessionId);
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
      const startX = event.clientX;
      const startWidth = rightPanelWidth;
      setIsPanelResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (e: MouseEvent): void => {
        // The handle sits on the panel's inner edge, so dragging away from the
        // dock side widens it: right-docked grows leftwards, left-docked grows
        // rightwards.
        const delta = e.clientX - startX;
        const next = Math.max(
          SESSION_RIGHT_PANEL_MIN,
          Math.min(SESSION_RIGHT_PANEL_MAX, dock === "left" ? startWidth + delta : startWidth - delta)
        );
        setRightPanelWidth(next);
      };
      const cleanup = (): void => {
        setIsPanelResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragCleanupRef.current = null;
      };
      const onMouseUp = (): void => cleanup();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = cleanup;
    },
    [rightPanelWidth]
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
      <div className="session-main-column">
        <SessionConversation
          checks={checks}
          defaultToolCallsDisplay={defaultToolCallsDisplay}
          defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
          defaultThinkingExpanded={defaultThinkingExpanded}
          defaultTurnChangesExpanded={defaultTurnChangesExpanded}
          events={visibleEvents}
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
          onOpenAgent={handleOpenAgent}
          onToggleLog={toggleLog}
          isTerminalOpen={terminalOpen}
          onToggleTerminal={reviewState.toggleTerminal}
          workspaceCardEnabled={workspaceCardVisible}
          onHideWorkspaceCard={handleHideWorkspaceCard}
          onToggleWorkspaceCard={handleToggleWorkspaceCard}
          pendingApprovalCount={visibleApprovals.filter((a) => a.status === "pending").length}
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
                <p className="eyebrow">Pending</p>
                <h2>Approvals</h2>
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
      {reviewState.isPanelOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel
            agents={{
              events: visibleEvents,
              parentSession: session,
              workspace,
              onLoadAgentEvents,
              onLoadSessionEvents,
              onOpenAgent: handleOpenAgent
            }}
            review={reviewState}
            isFocused={isFocused}
            onAddReviewComment={session ? handleAddReviewComment : undefined}
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
