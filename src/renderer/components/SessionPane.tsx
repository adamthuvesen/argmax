import { ShieldAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  ApprovalRequest,
  CheckRun,
  CommitPreparation,
  PrepareCommitInput,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { DebugLogPanel } from "./DebugLogPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { SessionConversation } from "./SessionConversation.js";
import { TerminalPanel } from "./TerminalPanel.js";

const SESSION_RIGHT_PANEL_WIDTH_KEY = "argmax.session.rightPanel.width";
const SESSION_RIGHT_PANEL_MIN = 260;
const SESSION_RIGHT_PANEL_MAX = 760;
const SESSION_RIGHT_PANEL_DEFAULT = 420;

const TERMINAL_HEIGHT_KEY = "argmax.terminal.height";
const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_MAX_HEIGHT = 600;
const TERMINAL_DEFAULT_HEIGHT = 280;

export function SessionPane({
  approvals,
  checks,
  defaultToolCallsExpanded,
  events,
  onResolveApproval,
  onSendSessionInput,
  onTerminateSession,
  onCreateCheckpoint,
  onPrepareCommit,
  onRunCheck,
  project,
  rawOutputs,
  session,
  thinkingStyle,
  workspace
}: {
  approvals: ApprovalRequest[];
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onPrepareCommit?: (input: PrepareCommitInput) => Promise<CommitPreparation>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  thinkingStyle?: ThinkingStyle;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  // Wrap in useMemo so the hook's source identity is stable between renders —
  // otherwise a fresh object every render would invalidate downstream deps.
  const reviewSource = useMemo<ReviewSource | null>(
    () => (workspace ? { kind: "workspace", workspace } : null),
    [workspace]
  );
  const reviewState = useReviewState(reviewSource);
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
  const [isTerminalResizing, setIsTerminalResizing] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(TERMINAL_HEIGHT_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= TERMINAL_MIN_HEIGHT && n <= TERMINAL_MAX_HEIGHT ? n : TERMINAL_DEFAULT_HEIGHT;
  });
  // Close the terminal when the session/workspace context goes away so a
  // stale PTY isn't kept alive against an archived worktree.
  useEffect(() => {
    if (!workspace) setIsTerminalOpen(false);
  }, [workspace]);
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "j") return;
      // Allow toggling when focus is inside the terminal itself, since the
      // panel is the thing the shortcut controls.
      const target = event.target as HTMLElement | null;
      const insideTerminal = target?.closest('[data-argmax-terminal="true"]') !== null;
      if (!insideTerminal && isTypingTarget(event.target)) return;
      event.preventDefault();
      setIsTerminalOpen((open) => !open);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isLogOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setIsLogOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isLogOpen]);

  // Destructure so the effect's dep is the stable useCallback from inside
  // useReviewState — not the parent object, which would expand the effect's
  // dep audit to the whole review state and trip exhaustive-deps.
  const reviewTogglePanel = reviewState.togglePanel;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      reviewTogglePanel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [reviewTogglePanel]);

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
          events={visibleEvents}
          isLogOpen={isLogOpen}
          onSendSessionInput={onSendSessionInput}
          onTerminateSession={onTerminateSession}
          onCreateCheckpoint={onCreateCheckpoint}
          onRunCheck={onRunCheck}
          onToggleLog={toggleLog}
          pendingApprovalCount={visibleApprovals.filter((a) => a.status === "pending").length}
          project={project}
          rawOutputs={rawOutputs}
          review={reviewState}
          session={session}
          {...(thinkingStyle ? { thinkingStyle } : {})}
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
        {terminalOpen && workspace ? (
          <div
            className="terminal-panel"
            data-argmax-terminal="true"
            style={{ height: `${terminalHeight}px` }}
          >
            <div
              className="terminal-panel-resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize terminal"
              onMouseDown={onTerminalResizeMouseDown}
            />
            <div className="terminal-panel-header">
              <span className="terminal-panel-title">Terminal</span>
              <span className="terminal-panel-cwd" title={workspace.path}>
                {workspace.path}
              </span>
              <button
                type="button"
                className="terminal-panel-close"
                aria-label="Hide terminal"
                title="Hide terminal (⌘J)"
                onClick={() => setIsTerminalOpen(false)}
              >
                ×
              </button>
            </div>
            <TerminalPanel workspaceId={workspace.id} visible={terminalOpen} />
          </div>
        ) : null}
      </div>
      {reviewState.isPanelOpen ? (
        <ReviewPanel
          review={reviewState}
          onResizePanelMouseDown={onRightPanelResizeMouseDown}
          workspace={workspace}
          onPrepareCommit={onPrepareCommit}
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
