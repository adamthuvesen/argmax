import {
  Bot,
  ChevronDown,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  PanelRightClose,
  SquareTerminal,
  X
} from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import {
  REVIEW_SCOPE_LABELS,
  type ReviewChangesScope,
  type ReviewPanelMode,
  type ReviewState,
  type WorkspaceFilesState
} from "../hooks/useReviewState.js";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { MultitaskChild } from "../lib/multitask.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentsView } from "./AgentsView.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { statusLabel, summarizeChangedFiles } from "../lib/changedFiles.js";
import { DEFAULT_BROWSER_URL } from "../lib/browserPanel.js";
import { readBoundedNumberPreference } from "../lib/uiPreferences.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { ChangeCount } from "./ChangeCount.js";
import { DiffBlocks } from "./DiffBlocks.js";
import type { ReviewCommentInput } from "../lib/composerAnnotations.js";
import { FilePreview, type EditorCursor } from "./FilePreview.js";
import { languageLabelFor } from "../lib/fileLanguage.js";
import { LinesSkeleton } from "./LinesSkeleton.js";
import { WorkspaceTree } from "./WorkspaceTree.js";
import { FileIcon } from "@react-symbols/icons/utils";
import { registerReviewFileTabCloseHandler } from "../lib/reviewFilePanel.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import { closeTerminalTab, getWorkspaceTerminalState, subscribeTerminalTabs } from "../lib/terminalTabs.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";

// The Terminal view pulls in @xterm/xterm + addons + xterm CSS — heavy, and
// only needed once the reader actually asks for a shell. SessionPane warms
// the same chunk on idle, so the first ⌘J paints immediately.
const TerminalTabsPanel = lazy(async () => ({
  default: (await import("./TerminalTabsPanel.js")).TerminalTabsPanel
}));

/** What the Agents view needs from the pane that owns the panel. */
export interface AgentsPanelContext {
  events: TimelineEvent[];
  /** Chat verbosity, so a subagent's transcript reads at the same detail as
   *  the chat that launched it. */
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  parentSession: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  /** Multitasks dispatched from this session. Their chats run in this dock, so
   *  the panel needs both the sessions and the commands to drive them. */
  multitasks?: MultitaskChild[];
  /** Every session's events. `events` above is scoped to this pane's session,
   *  which is exactly what a subagent transcript needs and exactly what a
   *  multitask's own chat does not. */
  multitaskEvents?: TimelineEvent[];
  pendingMessages?: Record<string, PendingMessage[]>;
  rawOutputs?: RawProviderOutput[];
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onClearSession?: (sessionId: string) => Promise<void>;
  onOpenFullChat?: (sessionId: string) => void;
  onSendQueuedMessageNow?: (sessionId: string, messageId: string) => Promise<void>;
  onSendSessionInput?: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession?: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
}

function fileBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function statusGlyph(status: string): string {
  return statusLabel(status).slice(0, 1).toUpperCase();
}

function FileTabStrip({ state }: { state: WorkspaceFilesState }): JSX.Element | null {
  if (state.tabs.length === 0) return null;
  const promptPath = state.dirtyClosePrompt?.path ?? null;
  const promptName = promptPath ? fileBasename(promptPath) : null;
  return (
    <div className="file-tabs-shell">
      <div className="file-tabs" role="tablist" aria-label="Open files">
        {state.tabs.map((tab) => {
          const isActive = tab.path === state.activeTabPath;
          return (
            <div className="file-tab" data-active={isActive ? "true" : "false"} key={tab.path}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={tab.path}
                onClick={() => state.selectTab(tab.path)}
              >
                <span className="file-tab-icon" aria-hidden="true">
                  <FileIcon
                    fileName={fileBasename(tab.path)}
                    autoAssign
                    editFileNameData={SPECIAL_FILE_ICONS}
                    width={13}
                    height={13}
                  />
                </span>
                <span className="file-tab-name">{fileBasename(tab.path)}</span>
                {tab.isDirty ? (
                  <span className="file-tab-dirty" aria-label="Unsaved changes" title="Unsaved changes">
                    •
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="file-tab-close"
                aria-label={`Close ${tab.path}`}
                title={`Close ${tab.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  state.closeTab(tab.path);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {promptPath ? (
        <div className="file-tab-close-prompt" role="alert" aria-label={`Unsaved changes in ${promptPath}`}>
          <span>
            Save changes to <strong>{promptName}</strong>?
          </span>
          {state.dirtyClosePrompt?.saveError ? (
            <span className="file-tab-close-prompt-error">{state.dirtyClosePrompt.saveError}</span>
          ) : null}
          <div className="file-tab-close-prompt-actions">
            <button
              type="button"
              onClick={() => void state.saveDirtyTabAndClose()}
              disabled={state.saveState === "saving"}
            >
              {state.saveState === "saving" ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={state.discardDirtyTabAndClose}>
              Discard
            </button>
            <button type="button" onClick={state.cancelDirtyTabClose}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function scopeDescription(scope: ReviewChangesScope, baseLabel: string | null): string {
  const base = baseLabel ?? "the base branch";
  switch (scope) {
    case "branch":
      return `Everything different from ${base}: committed, uncommitted, and untracked`;
    case "committed":
      return `Only what has been committed on this branch since ${base}`;
    case "uncommitted":
      return "Only the working tree: uncommitted, vs HEAD";
    case "lastTurn":
      return "Only the files the agent wrote in its most recent turn";
  }
}

/** Which slice of the branch's work the Changes list covers. */
function ReviewScopePicker({ review }: { review: ReviewState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideOrEscape(anchorRef, open, close);

  return (
    <div className="review-scope-anchor" ref={anchorRef}>
      <button
        type="button"
        className="review-comparison-toggle"
        aria-label={`Changes shown: ${REVIEW_SCOPE_LABELS[review.changesScope]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={scopeDescription(review.changesScope, review.comparisonBaseLabel)}
        onClick={() => setOpen((current) => !current)}
      >
        {REVIEW_SCOPE_LABELS[review.changesScope]}
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="project-picker-popover review-scope-popover" role="listbox" aria-label="Changes shown">
          {review.availableScopes.map((scope) => (
            <li key={scope} role="option" aria-selected={scope === review.changesScope}>
              <button
                type="button"
                className="project-picker-item"
                aria-pressed={scope === review.changesScope}
                title={scopeDescription(scope, review.comparisonBaseLabel)}
                onClick={() => {
                  review.setChangesScope(scope);
                  close();
                }}
              >
                {REVIEW_SCOPE_LABELS[scope]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const LEFT_COL_WIDTH_KEY = "argmax.reviewPanel.leftColumnWidth";
const LEFT_COL_MIN = 200;
const LEFT_COL_MAX = 600;
const LEFT_COL_DEFAULT = 280;
const PREVIEW_COL_MIN = 160;
const REVIEW_RESIZE_HANDLE_WIDTH = 5;
/** Until the user drags the divider the tree takes a share of the panel rather
 *  than a fixed 280px — a panel dragged out to half the window used to leave
 *  the tree a sliver against a vast empty preview. */
const LEFT_COL_AUTO_RATIO = 0.22;
const LEFT_COL_AUTO_MIN = 260;
const LEFT_COL_AUTO_MAX = 420;
/** Past this the toolbar has room to label its mode tabs instead of relying on
 *  two bare icons. */
const PANEL_WIDE_BREAKPOINT = 640;

function maxLeftColumnWidth(panelWidth: number): number {
  return Math.max(
    LEFT_COL_MIN,
    Math.min(LEFT_COL_MAX, panelWidth - PREVIEW_COL_MIN - REVIEW_RESIZE_HANDLE_WIDTH)
  );
}

function autoLeftColumnWidth(panelWidth: number): number {
  if (panelWidth <= 0) return LEFT_COL_AUTO_MIN;
  const share = Math.round(panelWidth * LEFT_COL_AUTO_RATIO);
  return Math.max(LEFT_COL_AUTO_MIN, Math.min(LEFT_COL_AUTO_MAX, share));
}

/** Null when the user has never dragged the divider, which hands the width to
 *  `autoLeftColumnWidth` instead of freezing it at the stored default. */
function readStoredLeftColumnWidth(): number | null {
  if (typeof window === "undefined") return null;
  if (window.localStorage.getItem(LEFT_COL_WIDTH_KEY) === null) return null;
  return readBoundedNumberPreference(LEFT_COL_WIDTH_KEY, {
    min: LEFT_COL_MIN,
    max: LEFT_COL_MAX,
    fallback: LEFT_COL_DEFAULT
  });
}

function writeLeftColumnWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LEFT_COL_WIDTH_KEY, String(width));
  } catch {
    // Quota or private-mode failures are non-fatal for a pane width.
  }
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export function ReviewPanel({
  agents,
  isFocused = true,
  onAddReviewComment,
  onResizePanelMouseDown,
  review
}: {
  /** Present only on a pane with a session behind it. Without it the panel has
   *  no Agents tab — the launcher has no transcript to spawn subagents from. */
  agents?: AgentsPanelContext;
  /** False for a panel in an unfocused pane: its document-level ⌘W must not
   *  close a tab in a panel the user isn't looking at. */
  isFocused?: boolean;
  /** When provided, diff lines grow a hover "+" for line comments; submitted
   *  comments become composer annotations on the pane's session. */
  onAddReviewComment?: (input: ReviewCommentInput) => void;
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  review: ReviewState;
}): JSX.Element {
  // The Browser tab needs the desktop bridge; the Agents tab only exists with
  // `agents`, so a mode that outlived a source switch (session pane ->
  // launcher) resolves back to Changes.
  const hasBrowser = typeof window !== "undefined" && Boolean(window.argmax?.browser);
  const terminalWorkspaceId = review.terminalWorkspaceId;
  const unavailable =
    (review.mode === "agents" && !agents) ||
    (review.mode === "browser" && !hasBrowser) ||
    (review.mode === "terminal" && !terminalWorkspaceId);
  const mode: ReviewPanelMode = unavailable ? "changes" : review.mode;
  const isChanges = mode === "changes";
  const isAgents = mode === "agents";
  const isBrowser = mode === "browser";
  const isTerminal = mode === "terminal";
  // Terminals outlive the view: once a workspace has tabs the panel keeps them
  // mounted (hidden) while the reader is on another mode, so coming back is
  // instant and nothing is torn down. An empty workspace mounts only on
  // entering Terminal mode — otherwise merely opening the panel would spawn a
  // shell nobody asked for.
  const terminalTabs = useSyncExternalStore(subscribeTerminalTabs, () =>
    getWorkspaceTerminalState(terminalWorkspaceId)
  );
  const terminalMounted = terminalWorkspaceId !== null && (isTerminal || terminalTabs.tabs.length > 0);
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const [leftColumnWidth, setLeftColumnWidth] = useState<number | null>(() => readStoredLeftColumnWidth());
  const [panelWidth, setPanelWidth] = useState(0);
  const [cursor, setCursor] = useState<EditorCursor | null>(null);
  const [collapsedDiffPath, setCollapsedDiffPath] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // One measurement feeds three things: the auto tree width, the wide-toolbar
  // switch, and the clamp that keeps a stored width off the preview column.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const measure = (): void => {
      const width = panel.clientWidth;
      setPanelWidth(width);
      const maxW = maxLeftColumnWidth(width);
      setLeftColumnWidth((current) => (current !== null && current > maxW ? maxW : current));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [review.mode]);

  const effectiveLeftColumnWidth = Math.min(
    leftColumnWidth ?? autoLeftColumnWidth(panelWidth),
    maxLeftColumnWidth(panelWidth)
  );

  // ⌘W closes the active tab whichever strip owns it, so a subagent tab
  // behaves like the file tab beside it.
  const closeActiveAgentTab = useCallback((): void => {
    const activeTabId = review.agentTabs.activeTabId;
    if (activeTabId) review.agentTabs.closeTab(activeTabId);
  }, [review.agentTabs]);

  const activeTerminalTabId = terminalTabs.activeTabId;
  const closeActiveTerminalTab = useCallback((): void => {
    if (terminalWorkspaceId && activeTerminalTabId) {
      closeTerminalTab(terminalWorkspaceId, activeTerminalTabId);
    }
  }, [activeTerminalTabId, terminalWorkspaceId]);

  useEffect(() => {
    if (!isFocused) {
      registerReviewFileTabCloseHandler(null);
      return undefined;
    }
    if (isTerminal) {
      if (!activeTerminalTabId) {
        registerReviewFileTabCloseHandler(null);
        return undefined;
      }
      registerReviewFileTabCloseHandler(closeActiveTerminalTab);
      return () => registerReviewFileTabCloseHandler(null);
    }
    if (isAgents) {
      if (!review.agentTabs.activeTabId) {
        registerReviewFileTabCloseHandler(null);
        return undefined;
      }
      registerReviewFileTabCloseHandler(closeActiveAgentTab);
      return () => registerReviewFileTabCloseHandler(null);
    }
    if (review.mode !== "files") {
      registerReviewFileTabCloseHandler(null);
      return undefined;
    }
    const activePath = review.workspaceFiles.activeTabPath;
    if (!activePath) {
      registerReviewFileTabCloseHandler(null);
      return undefined;
    }
    const closeActiveTab = (): void => {
      const path = review.workspaceFiles.activeTabPath;
      if (path) review.workspaceFiles.closeTab(path);
    };
    registerReviewFileTabCloseHandler(closeActiveTab);
    return () => registerReviewFileTabCloseHandler(null);
  }, [
    activeTerminalTabId,
    closeActiveAgentTab,
    closeActiveTerminalTab,
    isAgents,
    isFocused,
    isTerminal,
    review.mode,
    review.agentTabs.activeTabId,
    review.workspaceFiles
  ]);

  useEffect(() => {
    if (!isFocused) return undefined;
    if (review.mode !== "files") return undefined;
    const activePath = review.workspaceFiles.activeTabPath;
    if (!activePath) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "w") return;
      if (event.isComposing || event.repeat) return;
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      review.workspaceFiles.closeTab(activePath);
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isFocused, review.mode, review.workspaceFiles]);

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

  const handleResizeMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = effectiveLeftColumnWidth;
    // Touching the divider at all pins the width: from here the panel keeps the
    // user's number instead of re-deriving a share of its own width.
    let latest = startW;
    const maxW = maxLeftColumnWidth(panelRef.current?.clientWidth ?? 800);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (me: MouseEvent) => {
      latest = Math.max(LEFT_COL_MIN, Math.min(startW + me.clientX - startX, maxW));
      setLeftColumnWidth(latest);
    };
    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      setLeftColumnWidth(latest);
      writeLeftColumnWidth(latest);
      cleanup();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    dragCleanupRef.current = cleanup;
  };

  const summaryStrip = isChanges && review.files.length > 0
    ? `${review.files.length} file${review.files.length === 1 ? "" : "s"} · +${totals.additions} −${totals.deletions}`
    : null;
  const expandedFilePath = selectedFile && collapsedDiffPath !== selectedFile.path ? selectedFile.path : null;
  const sourceLabel = review.workspaceFiles.rootPath?.split("/").filter(Boolean).pop() ?? "Files";
  const entryCountLabel = `${review.workspaceFiles.entries.length} file${
    review.workspaceFiles.entries.length === 1 ? "" : "s"
  }`;
  const saveStatusLabel =
    review.workspaceFiles.saveState === "saving"
      ? "Saving…"
      : review.workspaceFiles.isDirty
        ? "Unsaved"
        : null;

  const toggleChangedFile = (filePath: string): void => {
    if (review.selectedFilePath === filePath) {
      setCollapsedDiffPath((current) => (current === filePath ? null : filePath));
      return;
    }
    setCollapsedDiffPath(null);
    review.openFile(filePath);
  };

  // ⌘S has no button of its own. The editor's Mod-s keymap covers a focused
  // CodeMirror; this catches the rest of Files mode — the tab strip and the
  // tree are siblings of the preview, so a handler on the preview alone misses
  // them and the save silently never happens.
  const files = review.workspaceFiles;
  const lineCount = useMemo(
    () => (files.buffer === null ? null : countLines(files.buffer)),
    [files.buffer]
  );
  const handleFilesModeKeyShortcut = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isChanges || isBrowser || isTerminal) return;
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      if (files.canEdit && files.isDirty && files.saveState !== "saving") void files.saveFile();
      return;
    }
    if (key === "w" && files.activeTabPath) {
      event.preventDefault();
      files.closeTab(files.activeTabPath);
    }
  };

  return (
    <aside
      className="review-panel"
      // The agent window's chat scale is about reading the transcript. The
      // review panel is sidebar-class chrome — files, changes, and the diff
      // code between them — so it holds the app-chrome scale, matching the
      // left sidebar and the workspace card. See tokens.css.
      data-type-scale="chrome"
      data-wide={panelWidth >= PANEL_WIDE_BREAKPOINT ? "true" : "false"}
      aria-label="Review panel"
      ref={panelRef}
    >
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div className="review-toolbar">
        <div className="review-toolbar-titles">
          <div className="review-mode-tabs" role="tablist" aria-label="Review panel mode">
            <button
              role="tab"
              type="button"
              aria-label="Changes"
              aria-selected={isChanges}
              title="Changes"
              onClick={() => review.setMode("changes")}
            >
              <GitBranch size={14} aria-hidden="true" />
              <span className="review-mode-tab-label">Changes</span>
            </button>
            <button
              role="tab"
              type="button"
              aria-label="Files"
              aria-selected={mode === "files"}
              title="Files"
              onClick={() => review.setMode("files")}
            >
              <Folder size={14} aria-hidden="true" />
              <span className="review-mode-tab-label">Files</span>
            </button>
            {agents ? (
              <button
                role="tab"
                type="button"
                aria-label="Agents"
                aria-selected={isAgents}
                title="Agents"
                onClick={() => review.setMode("agents")}
              >
                {/* Bot's glyph carries more inner padding than GitBranch/Folder, so it needs 16 to read the same size. */}
                <Bot size={16} aria-hidden="true" />
                <span className="review-mode-tab-label">Agents</span>
                {review.agentTabs.tabIds.length > 1 ? (
                  <span className="review-mode-tab-count">{review.agentTabs.tabIds.length}</span>
                ) : null}
              </button>
            ) : null}
            {hasBrowser ? (
              <button
                role="tab"
                type="button"
                aria-label="Browser"
                aria-selected={isBrowser}
                title="Browser"
                onClick={review.openBrowser}
              >
                <Globe size={14} aria-hidden="true" />
                <span className="review-mode-tab-label">Browser</span>
              </button>
            ) : null}
            {terminalWorkspaceId ? (
              <button
                role="tab"
                type="button"
                aria-label="Terminal"
                aria-selected={isTerminal}
                title="Terminal (⌘J)"
                onClick={review.openTerminal}
              >
                <SquareTerminal size={14} aria-hidden="true" />
                <span className="review-mode-tab-label">Terminal</span>
                {terminalTabs.tabs.length > 1 ? (
                  <span className="review-mode-tab-count">{terminalTabs.tabs.length}</span>
                ) : null}
              </button>
            ) : null}
          </div>
        </div>
        <div className="review-toolbar-actions">
          {isChanges ? <ReviewScopePicker review={review} /> : null}
          <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
            <PanelRightClose size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div
        className={
          isChanges
            ? "review-body review-body-changes"
            : isAgents
              ? "review-body review-body-agents"
              : isBrowser
                ? "review-body review-body-browser"
                : isTerminal
                  ? "review-body review-body-terminal"
                  : "review-body"
        }
        onKeyDown={handleFilesModeKeyShortcut}
      >
        {isBrowser ? (
          review.browserOwner ? (
            <BrowserPanel
              url={review.browserRequest?.url ?? DEFAULT_BROWSER_URL}
              requestSeq={review.browserRequest?.seq}
              requestTabId={review.browserRequest?.tabId}
              onClose={review.closePanel}
            />
          ) : (
            // One native surface, one browser: this panel kept Browser mode
            // but the page went elsewhere — another pane took it over, or the
            // pane that held it closed its panel.
            <div className="review-empty">
              <span className="review-empty-mark" aria-hidden="true">↗</span>
              <span>The browser moved to another pane.</span>
              <button type="button" className="review-empty-action" onClick={review.openBrowser}>
                Show here
              </button>
            </div>
          )
        ) : null}
        {terminalMounted && terminalWorkspaceId ? (
          <Suspense fallback={null}>
            <div className="review-terminal-mount" hidden={!isTerminal}>
              <TerminalTabsPanel
                key={terminalWorkspaceId}
                workspaceId={terminalWorkspaceId}
                visible={isTerminal}
                cwdLabel={review.workspaceFiles.rootPath}
              />
            </div>
          </Suspense>
        ) : null}
        {isAgents && agents ? (
          <AgentsView
            events={agents.events}
            defaultToolCallsDisplay={agents.defaultToolCallsDisplay}
            defaultToolCallGroupsExpanded={agents.defaultToolCallGroupsExpanded}
            defaultThinkingExpanded={agents.defaultThinkingExpanded}
            isFocused={isFocused}
            parentSession={agents.parentSession}
            agentTabs={review.agentTabs}
            workspace={agents.workspace}
            onLoadAgentEvents={agents.onLoadAgentEvents}
            onLoadSessionEvents={agents.onLoadSessionEvents}
            onOpenAgent={agents.onOpenAgent}
            onOpenFile={review.openInFilesView}
            multitasks={agents.multitasks}
            multitaskEvents={agents.multitaskEvents}
            pendingMessages={agents.pendingMessages}
            rawOutputs={agents.rawOutputs}
            onCancelQueuedMessage={agents.onCancelQueuedMessage}
            onClearSession={agents.onClearSession}
            onOpenFullChat={agents.onOpenFullChat}
            onSendQueuedMessageNow={agents.onSendQueuedMessageNow}
            onSendSessionInput={agents.onSendSessionInput}
            onTerminateSession={agents.onTerminateSession}
          />
        ) : null}
        {isChanges || isAgents || isBrowser || isTerminal ? null : (
          <>
            <div className="review-list-col" style={{ width: effectiveLeftColumnWidth }}>
              <WorkspaceTree state={files} toolbar={{ onRefresh: files.refreshList }} />
            </div>
            <div
              className="review-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file list width"
              onMouseDown={handleResizeMouseDown}
            />
          </>
        )}
        {isAgents || isBrowser || isTerminal ? null : (
        <div className={isChanges ? "review-diff" : "review-diff review-diff-files"}>
          {isChanges ? (
            <>
              {review.filesState === "ready" && review.files.length === 0 ? (
                <p className="review-empty">
                  <span className="review-empty-mark" aria-hidden="true">∅</span>
                  <span>No changes.</span>
                </p>
              ) : null}
              {review.files.length > 0 ? (
                <div className="review-changed-file-stack" aria-label="Changed files">
                  {review.files.map((file) => {
                    const isExpanded = expandedFilePath === file.path;
                    const glyph = statusGlyph(file.status);
                    return (
                      <section className="review-changed-file-section" key={file.path} data-expanded={isExpanded ? "true" : "false"}>
                        <div className="review-changed-file-row">
                          <button
                            className="review-changed-file-toggle"
                            type="button"
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${file.path} diff`}
                            aria-expanded={isExpanded}
                            aria-controls={`review-diff-${file.path}`}
                            title={`${isExpanded ? "Collapse" : "Expand"} ${file.path}`}
                            data-status={glyph.toLowerCase()}
                            onClick={() => toggleChangedFile(file.path)}
                          >
                            <span className="review-file-row-status" aria-hidden="true">{glyph}</span>
                            <span className="review-file-row-path">{file.path}</span>
                          </button>
                          <ChangeCount additions={file.additions} deletions={file.deletions} />
                          <button
                            className="small-icon"
                            type="button"
                            title={`Open ${file.path} in Files view`}
                            aria-label={`Open ${file.path} in Files view`}
                            onClick={() => review.openInFilesView(file.path)}
                          >
                            <FolderOpen size={16} />
                          </button>
                        </div>
                        {isExpanded ? (
                          <div className="review-inline-diff" id={`review-diff-${file.path}`}>
                            {review.diffState === "loading" ? (
                              <LinesSkeleton rows={14} label="Loading diff" className="review-diff-skeleton" />
                            ) : null}
                            {review.diffState === "error" ? (
                              <p className="review-empty review-error" role="alert">
                                <span className="review-empty-mark" aria-hidden="true">!</span>
                                <span>{review.diffError ?? "Couldn't load this diff."}</span>
                              </p>
                            ) : null}
                            {review.diffState === "ready" && diffBlocks.length === 0 ? (
                              <p className="review-empty">
                                <span className="review-empty-mark" aria-hidden="true">∅</span>
                                <span>No textual diff.</span>
                              </p>
                            ) : null}
                            {review.diffState === "ready" && diffBlocks.length > 0 ? (
                              <DiffBlocks
                                blocks={diffBlocks}
                                filePath={file.path}
                                onAddComment={onAddReviewComment}
                                onExpandContext={review.expandDiffContext}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <FileTabStrip state={review.workspaceFiles} />
              <FilePreview state={files} onCursorChange={setCursor} />
            </>
          )}
        </div>
        )}
      </div>
      {summaryStrip ? (
        <footer className="review-footer" aria-hidden="true">
          <span className="review-footer-mark">└─</span>
          <span className="review-footer-text">{summaryStrip}</span>
        </footer>
      ) : null}
      {isChanges || isAgents || isBrowser || isTerminal ? null : (
        <footer className="review-status-bar" aria-label="File status">
          <span className="review-status-path" title={files.selectedPath ?? sourceLabel}>
            {files.selectedPath ?? entryCountLabel}
          </span>
          <span className="review-status-meta">
            {saveStatusLabel ? (
              <span className="review-status-save" data-state={files.saveState}>
                {saveStatusLabel}
              </span>
            ) : null}
            {files.selectedPath ? <span>{languageLabelFor(files.selectedPath)}</span> : null}
            {lineCount === null ? null : (
              <span>
                {lineCount} {lineCount === 1 ? "line" : "lines"}
              </span>
            )}
            {cursor ? (
              <span>
                Ln {cursor.line}, Col {cursor.column}
              </span>
            ) : null}
          </span>
        </footer>
      )}
    </aside>
  );
}
