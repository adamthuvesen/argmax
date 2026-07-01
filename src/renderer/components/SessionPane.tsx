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
import type {
  AgentMode,
  ApprovalRequest,
  CheckRun,
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { useStableFilter } from "../hooks/useStableFilter.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { CommitDialog } from "./CommitDialog.js";
import { DebugLogPanel } from "./DebugLogPanel.js";
// ReviewPanel lazy-mounted (ralph B4); Vite emits a single ReviewPanel-*
// chunk shared with the LaunchSurface call site.
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel.js")).ReviewPanel
}));
import { SessionConversation } from "./SessionConversation.js";
// TerminalTabsPanel pulls in @xterm/xterm + addons + xterm CSS — heavy and
// only loaded when the user opens the integrated terminal. Lazy-mounted
// (ralph B5) so xterm leaves the main chunk. The importer is named so it can
// also be prefetched on idle (see the warm-up effect below).
const importTerminalPanel = () => import("./TerminalTabsPanel.js");
const TerminalTabsPanel = lazy(async () => ({
  default: (await importTerminalPanel()).TerminalTabsPanel
}));

const SESSION_RIGHT_PANEL_WIDTH_KEY = "argmax.session.rightPanel.width";
const SESSION_RIGHT_PANEL_MIN = 360;
const SESSION_RIGHT_PANEL_MAX = 1400;
const SESSION_RIGHT_PANEL_DEFAULT = 420;

const TERMINAL_HEIGHT_KEY = "argmax.terminal.height";
const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_MAX_HEIGHT = 600;
const TERMINAL_DEFAULT_HEIGHT = 280;
export function SessionPane({
  approvals,
  checks,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  events,
  fastModeEnabled = false,
  isFocused = true,
  onClose,
  onCreateCheckpoint,
  onFastModeEnabledChange,
  onLoadSessionEvents,
  onResolveApproval,
  onRunCheck,
  onSendSessionInput,
  onCancelQueuedMessage,
  pendingMessages,
  onTerminateSession,
  project,
  rawOutputs,
  registerPaletteFileContext,
  rightPanelToggleSignal,
  debugLogToggleSignal,
  terminalToggleSignal,
  session,
  showCostPanel = true,
  thinkingStyle,
  workspace
}: {
  approvals: ApprovalRequest[];
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  events: TimelineEvent[];
  fastModeEnabled?: boolean;
  /** When false, the pane skips its document-level keyboard shortcuts so only the focused pane reacts. */
  isFocused?: boolean;
  /** Close button is shown when provided. Used by the multi-pane grid; absent in single-pane mode. */
  onClose?: () => void;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  /** Called on mount and on session.id change to backfill timeline events for this pane's session. */
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ModelPickerSelection, agentMode: AgentMode) => Promise<void>;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  pendingMessages?: Record<string, PendingMessage[]>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  rightPanelToggleSignal?: number;
  debugLogToggleSignal?: number;
  terminalToggleSignal?: number;
  session: SessionSummary | null;
  showCostPanel?: boolean;
  thinkingStyle?: ThinkingStyle;
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
  const reviewState = useReviewState(reviewSource);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SESSION_RIGHT_PANEL_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= SESSION_RIGHT_PANEL_MIN && n <= SESSION_RIGHT_PANEL_MAX
      ? n
      : SESSION_RIGHT_PANEL_DEFAULT;
  });
  const toggleLog = useCallback(() => setIsLogOpen((v) => !v), []);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // True once the user has opened the terminal in the current workspace.
  // Lets the panel stay mounted (PTYs alive) across ⌘J collapses while
  // still keeping the heavy xterm bundle off the initial render. Resets on
  // workspace change so old PTYs are torn down with the leaf components.
  const [terminalOnceOpened, setTerminalOnceOpened] = useState(false);
  const [isTerminalResizing, setIsTerminalResizing] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(TERMINAL_HEIGHT_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= TERMINAL_MIN_HEIGHT && n <= TERMINAL_MAX_HEIGHT ? n : TERMINAL_DEFAULT_HEIGHT;
  });
  useEffect(() => {
    if (isTerminalOpen) setTerminalOnceOpened(true);
  }, [isTerminalOpen]);
  // Reset the terminal panel whenever the session/workspace context changes
  // or clears — the leaf components unmount and their PTYs are terminated.
  useEffect(() => {
    setIsTerminalOpen(false);
    setTerminalOnceOpened(false);
  }, [workspace?.id]);
  const handleTerminalCollapse = useCallback(() => {
    setIsTerminalOpen(false);
  }, []);
  const handleTerminalRequestClose = useCallback(() => {
    setIsTerminalOpen(false);
    setTerminalOnceOpened(false);
  }, []);
  // Stable per-session slices: a delta for another session leaves these
  // identity-equal, so the conversation's derived memos and memoized turns skip
  // work instead of re-deriving on every unrelated delta (matters most in the
  // multi-pane grid).
  const visibleApprovals = useStableFilter(approvals, sessionId, (approval) => approval.sessionId === sessionId);
  const visibleEvents = useStableFilter(events, sessionId, (event) => event.sessionId === sessionId);
  const visibleRawOutputs = useStableFilter(rawOutputs, sessionId, (output) => output.sessionId === sessionId);
  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    try {
      await onResolveApproval(approvalId, status);
    } catch {
      // Errors are surfaced through the parent toast system.
    }
  };

  const gridClass = ["session-grid", reviewState.isPanelOpen && "review-open", isLogOpen && "log-open"]
    .filter(Boolean)
    .join(" ");
  const reviewColumnWidth = `${rightPanelWidth}px`;
  const logColumnWidth = reviewState.isPanelOpen ? "clamp(300px, 32vw, 480px)" : `${rightPanelWidth}px`;
  const terminalOpen = isTerminalOpen && workspace !== null;
  const gridStyle = {
    "--session-review-panel-width": reviewColumnWidth,
    "--session-log-panel-width": logColumnWidth,
    "--session-terminal-height": terminalOpen ? `${terminalHeight}px` : "0px"
  } as CSSProperties;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SESSION_RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
  }, [terminalHeight]);


  // Destructure so the effect's dep is the stable useCallback from inside
  // useReviewState — not the parent object, which would expand the effect's
  // dep audit to the whole review state and trip exhaustive-deps.
  const reviewTogglePanel = reviewState.togglePanel;
  const reviewClosePanel = reviewState.closePanel;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const reviewMode = reviewState.mode;
  const handleOpenCommitDialog = useCallback(() => setIsCommitDialogOpen(true), []);
  const handleCloseCommitDialog = useCallback(() => setIsCommitDialogOpen(false), []);
  const workspaceId = workspace?.id ?? null;
  // After a commit the staged/changed set has shifted; refresh the workspace
  // status so the Changes panel updates immediately (the refresh publishes a
  // dashboard delta that bumps changedFilesKey) rather than showing stale rows
  // until the panel is reopened.
  const handleCommitted = useCallback((): void => {
    if (!workspaceId || !window.argmax) return;
    void window.argmax.workspaces.refreshStatus(workspaceId).catch(() => undefined);
  }, [workspaceId]);

  // Warm the heavy xterm chunk on idle once a workspace is present, so the first
  // Cmd+J paints the terminal immediately instead of showing blank panel space
  // while the bundle downloads. Deferred to idle so it never competes with the
  // session's own first paint; Vite caches the import, so the real open is instant.
  useEffect(() => {
    if (!workspaceId) return;
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const id = idle(() => void importTerminalPanel().catch(() => undefined));
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => void importTerminalPanel().catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [workspaceId]);
  const handleOpenFile = useCallback(
    (path: string, opts?: { line?: number | null; preferIde?: boolean }): void => {
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
    [reviewOpenInFilesView, workspaceId]
  );
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);
  const lastDebugLogToggleSignal = useRef(debugLogToggleSignal);
  const lastTerminalToggleSignal = useRef(0);

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
    if (!terminalToggleSignal || terminalToggleSignal === lastTerminalToggleSignal.current) return;
    lastTerminalToggleSignal.current = terminalToggleSignal;
    if (!isFocused || !workspace) return;
    setIsTerminalOpen((open) => !open);
  }, [isFocused, terminalToggleSignal, workspace]);

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

  const onTerminalResizeMouseDown = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    setIsTerminalResizing(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent): void => {
      // Dragging up grows the panel, dragging down shrinks it.
      const next = Math.max(
        TERMINAL_MIN_HEIGHT,
        Math.min(TERMINAL_MAX_HEIGHT, startHeight - (e.clientY - startY))
      );
      setTerminalHeight(next);
    };
    const cleanup = (): void => {
      setIsTerminalResizing(false);
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
  }, [terminalHeight]);

  const onRightPanelResizeMouseDown = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightPanelWidth;
    setIsPanelResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent): void => {
      // Dragging left should widen the panel; dragging right should narrow it.
      const next = Math.max(
        SESSION_RIGHT_PANEL_MIN,
        Math.min(SESSION_RIGHT_PANEL_MAX, startWidth - (e.clientX - startX))
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
  }, [rightPanelWidth]);

  return (
    <div
      className={gridClass}
      style={gridStyle}
      data-panel-resizing={isPanelResizing || isTerminalResizing ? "true" : undefined}
    >
      <div className="session-main-column" data-terminal-open={terminalOpen ? "true" : undefined}>
        <SessionConversation
          checks={checks}
          defaultToolCallsExpanded={defaultToolCallsExpanded}
          defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
          defaultThinkingExpanded={defaultThinkingExpanded}
          events={visibleEvents}
          fastModeEnabled={fastModeEnabled}
          isLogOpen={isLogOpen}
          onClose={onClose}
          onFastModeEnabledChange={onFastModeEnabledChange}
          onOpenCommitDialog={handleOpenCommitDialog}
          onSendSessionInput={onSendSessionInput}
          onCancelQueuedMessage={onCancelQueuedMessage}
          pendingMessages={sessionId ? (pendingMessages?.[sessionId] ?? []) : []}
          onTerminateSession={onTerminateSession}
          onCreateCheckpoint={onCreateCheckpoint}
          onRunCheck={onRunCheck}
          onOpenFile={handleOpenFile}
          onToggleLog={toggleLog}
          pendingApprovalCount={visibleApprovals.filter((a) => a.status === "pending").length}
          project={project}
          rawOutputs={rawOutputs}
          review={reviewState}
          session={session}
          showCostPanel={showCostPanel}
          {...(thinkingStyle ? { thinkingStyle } : {})}
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
        {terminalOnceOpened && workspace ? (
          <div
            className="terminal-panel"
            data-argmax-terminal="true"
            data-collapsed={terminalOpen ? "false" : "true"}
            aria-hidden={!terminalOpen}
            style={{ height: terminalOpen ? `${terminalHeight}px` : "0px" }}
          >
            <div
              className="terminal-panel-resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize terminal"
              onMouseDown={onTerminalResizeMouseDown}
            />
            <Suspense fallback={null}>
              <TerminalTabsPanel
                key={workspace.id}
                workspaceId={workspace.id}
                visible={terminalOpen}
                onCollapse={handleTerminalCollapse}
                onRequestClose={handleTerminalRequestClose}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
      {reviewState.isPanelOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel
            review={reviewState}
            onResizePanelMouseDown={onRightPanelResizeMouseDown}
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
        <DebugLogPanel
          events={visibleEvents}
          rawOutputs={visibleRawOutputs}
          onClose={() => setIsLogOpen(false)}
          onResizePanelMouseDown={reviewState.isPanelOpen ? undefined : onRightPanelResizeMouseDown}
        />
      ) : null}
    </div>
  );
}
