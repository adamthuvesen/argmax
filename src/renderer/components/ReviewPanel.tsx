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
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover, type AnchorPoint } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { PickerLead } from "./PickerLead.js";
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
  NativeAgentIdentity,
  PendingMessage,
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
import type { DiffNoteAnchor, DiffNoteInput } from "../lib/composerAnnotations.js";
import { FilePreview, type EditorCursor } from "./FilePreview.js";
import { languageLabelFor } from "../lib/fileLanguage.js";
import { LinesSkeleton } from "./LinesSkeleton.js";
import { WorkspaceTree } from "./WorkspaceTree.js";
import { FileIcon } from "@react-symbols/icons/utils";
import { registerReviewFileTabCloseHandler } from "../lib/reviewFilePanel.js";
import {
  MAX_REVIEW_SPLIT_RATIO,
  MIN_REVIEW_SPLIT_RATIO,
  isReviewPanelMode
} from "../lib/reviewLayout.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import { closeTerminalTab, getWorkspaceTerminalState, subscribeTerminalTabs } from "../lib/terminalTabs.js";
import type { ThinkingDisplay, ToolCallsDisplay } from "../lib/uiPreferences.js";

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
  thinkingDisplay?: ThinkingDisplay;
  parentSession: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onLoadAgentEvents?: (sessionId: string, parentToolUseId: string, identity?: NativeAgentIdentity) => Promise<void | { hasMore: boolean }>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenAgent?: (tool: ToolCall) => void;
  /** Multitasks dispatched from this session. Their chats run in this dock, so
   *  the panel needs both the sessions and the commands to drive them. */
  multitasks?: MultitaskChild[];
  pendingMessages?: Record<string, PendingMessage[]>;
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

const REVIEW_MODE_DRAG_MIME = "application/x-argmax-review-mode";
const REVIEW_PANEL_RATIO_STEP = 0.05;

interface ReviewModeTabsProps {
  activeMode: ReviewPanelMode;
  agentCount: number;
  hasAgents: boolean;
  hasBrowser: boolean;
  hasTerminal: boolean;
  onDragEnd: () => void;
  onDragStart: (mode: ReviewPanelMode, event: ReactDragEvent<HTMLButtonElement>) => void;
  onSelectMode: (mode: ReviewPanelMode) => void;
  onSplitBelow: (mode: ReviewPanelMode) => void;
  terminalCount: number;
}

function ReviewModeTabs({
  activeMode,
  agentCount,
  hasAgents,
  hasBrowser,
  hasTerminal,
  onDragEnd,
  onDragStart,
  onSelectMode,
  onSplitBelow,
  terminalCount
}: ReviewModeTabsProps): JSX.Element {
  const [menu, setMenu] = useState<{ mode: ReviewPanelMode; point: AnchorPoint } | null>(null);
  const popover = useAnchoredPopover({ open: menu !== null, gutter: 0, capHeight: true });
  const { anchorToPoint, floatingStyles, popoverRef, setPopover } = popover;
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismissOnOutsideOrEscape(popoverRef, menu !== null, closeMenu);

  useEffect(() => {
    anchorToPoint(menu?.point ?? null);
  }, [anchorToPoint, menu]);

  useEffect(() => {
    if (menu) popoverRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [menu, popoverRef]);

  const openMenu = (mode: ReviewPanelMode, x: number, y: number): void => {
    setMenu({ mode, point: { x, y } });
  };

  const handleKeyDown = (mode: ReviewPanelMode, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(mode, rect.left, rect.bottom + 4);
  };

  const modes: Array<{
    count?: number;
    icon: JSX.Element;
    label: string;
    mode: ReviewPanelMode;
  }> = [
    { mode: "changes", label: "Changes", icon: <GitBranch size={14} aria-hidden="true" /> },
    { mode: "files", label: "Files", icon: <Folder size={14} aria-hidden="true" /> },
    ...(hasAgents
      ? [{ mode: "agents" as const, label: "Agents", icon: <Bot size={16} aria-hidden="true" />, count: agentCount }]
      : []),
    ...(hasBrowser
      ? [{ mode: "browser" as const, label: "Browser", icon: <Globe size={14} aria-hidden="true" /> }]
      : []),
    ...(hasTerminal
      ? [{ mode: "terminal" as const, label: "Terminal", icon: <SquareTerminal size={14} aria-hidden="true" />, count: terminalCount }]
      : [])
  ];

  return (
    <>
      <div className="review-mode-tabs" role="tablist" aria-label="Review panel mode">
        {modes.map((item) => (
          <button
            role="tab"
            type="button"
            aria-label={item.label}
            aria-selected={activeMode === item.mode}
            title={item.mode === "terminal" ? "Terminal (⌘J)" : item.label}
            draggable
            key={item.mode}
            onClick={() => onSelectMode(item.mode)}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(item.mode, event.clientX, event.clientY);
            }}
            onDragEnd={onDragEnd}
            onDragStart={(event) => onDragStart(item.mode, event)}
            onKeyDown={(event) => handleKeyDown(item.mode, event)}
          >
            {item.icon}
            <span className="review-mode-tab-label">{item.label}</span>
            {item.count && item.count > 1 ? <span className="review-mode-tab-count">{item.count}</span> : null}
          </button>
        ))}
      </div>
      {menu && typeof document !== "undefined"
        ? createPortal(
            <ul
              ref={setPopover}
              className="project-picker-popover review-tab-context-menu"
              role="menu"
              aria-label={`${modes.find((item) => item.mode === menu.mode)?.label ?? menu.mode} tab actions`}
              data-browser-overlay="true"
              style={floatingStyles}
            >
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item"
                  onClick={() => {
                    onSplitBelow(menu.mode);
                    closeMenu();
                  }}
                >
                  Split below
                </button>
              </li>
            </ul>,
            document.body
          )
        : null}
    </>
  );
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

/**
 * What the diff on screen is taken against, in the few words a diff note
 * carries to the agent. A note's line number belongs to this comparison, not
 * necessarily to the file on disk.
 */
function diffBaseLabel(scope: ReviewChangesScope, baseLabel: string | null): string {
  const base = baseLabel ?? "the base branch";
  switch (scope) {
    case "branch":
    case "lastTurn":
      return `the whole branch vs ${base}`;
    case "committed":
      return `commits on this branch vs ${base}`;
    case "uncommitted":
      return "working tree vs HEAD";
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
                <PickerLead selected={scope === review.changesScope} />
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

function ReviewPanelPane({
  agents,
  isFocused = true,
  isSplit,
  onAddDiffNote,
  onTabDragEnd,
  onTabDragStart,
  ownsTerminalMount,
  paneIndex,
  paneSize,
  review
}: {
  /** Present only on a pane with a session behind it. Without it the panel has
   *  no Agents tab — the launcher has no transcript to spawn subagents from. */
  agents?: AgentsPanelContext;
  /** False for a panel in an unfocused pane: its document-level ⌘W must not
   *  close a tab in a panel the user isn't looking at. */
  isFocused?: boolean;
  isSplit: boolean;
  /** When provided, diff lines grow a hover "+" for line comments; submitted
   *  comments become diff-note annotations on the pane's session. */
  onAddDiffNote?: (input: DiffNoteInput) => void;
  onTabDragEnd: () => void;
  onTabDragStart: (mode: ReviewPanelMode, event: ReactDragEvent<HTMLButtonElement>) => void;
  ownsTerminalMount: boolean;
  paneIndex: 0 | 1;
  paneSize?: string;
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
  const terminalMounted = ownsTerminalMount && terminalWorkspaceId !== null && (isTerminal || terminalTabs.tabs.length > 0);
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  // The diff view knows the line; only the panel knows which comparison it was
  // taken against. Memoized because `DiffBlocks` is memoized on its props.
  const changesScope = review.changesScope;
  const comparisonBaseLabel = review.comparisonBaseLabel;
  const addDiffNote = useCallback(
    (anchor: DiffNoteAnchor): void => {
      onAddDiffNote?.({ ...anchor, base: diffBaseLabel(changesScope, comparisonBaseLabel) });
    },
    [onAddDiffNote, changesScope, comparisonBaseLabel]
  );
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
    if (!isFocused) return undefined;
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

  const panePosition = paneIndex === 0 ? "top" : "bottom";

  return (
    <section
      className="review-panel-pane"
      // The agent window's chat scale is about reading the transcript. The
      // review panel is sidebar-class chrome — files, changes, and the diff
      // code between them — so it holds the app-chrome scale, matching the
      // left sidebar and the workspace card. See tokens.css.
      data-type-scale="chrome"
      data-wide={panelWidth >= PANEL_WIDE_BREAKPOINT ? "true" : "false"}
      data-pane-index={paneIndex}
      data-pane-position={panePosition}
      aria-label={isSplit ? `${panePosition === "top" ? "Top" : "Bottom"} review pane` : "Review panel content"}
      ref={panelRef}
      style={paneSize ? { flexBasis: paneSize } : undefined}
      onFocusCapture={() => review.focusPane(paneIndex)}
      onPointerDownCapture={() => review.focusPane(paneIndex)}
    >
      <div className="review-toolbar">
        <div className="review-toolbar-titles">
          <ReviewModeTabs
            activeMode={mode}
            agentCount={review.agentTabs.tabIds.length}
            hasAgents={Boolean(agents)}
            hasBrowser={hasBrowser}
            hasTerminal={Boolean(terminalWorkspaceId)}
            onDragEnd={onTabDragEnd}
            onDragStart={onTabDragStart}
            onSelectMode={review.setMode}
            onSplitBelow={(splitMode) => review.splitMode(splitMode, "bottom")}
            terminalCount={terminalTabs.tabs.length}
          />
        </div>
        <div className="review-toolbar-actions">
          {isChanges ? <ReviewScopePicker review={review} /> : null}
          <button
            className="small-icon"
            type="button"
            title={isSplit ? `Close ${panePosition} pane` : "Close review"}
            aria-label={isSplit ? `Close ${panePosition} pane` : "Close review"}
            onClick={review.closePanel}
          >
            {isSplit ? <X size={15} /> : <PanelRightClose size={16} strokeWidth={1.75} />}
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
              panePosition={panePosition}
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
            thinkingDisplay={agents.thinkingDisplay}
            isFocused={isFocused}
            parentSession={agents.parentSession}
            agentTabs={review.agentTabs}
            workspace={agents.workspace}
            onLoadAgentEvents={agents.onLoadAgentEvents}
            onLoadSessionEvents={agents.onLoadSessionEvents}
            onOpenAgent={agents.onOpenAgent}
            onOpenDiff={review.openFile}
            onOpenFile={review.openInFilesView}
            onOpenReview={review.openChangesPanel}
            multitasks={agents.multitasks}
            pendingMessages={agents.pendingMessages}
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
                                onAddComment={onAddDiffNote ? addDiffNote : undefined}
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
    </section>
  );
}

export function ReviewPanel({
  agents,
  isFocused = true,
  onAddDiffNote,
  onResizePanelMouseDown,
  review
}: {
  agents?: AgentsPanelContext;
  isFocused?: boolean;
  onAddDiffNote?: (input: DiffNoteInput) => void;
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  review: ReviewState;
}): JSX.Element {
  const panelDragId = useId();
  const stackRef = useRef<HTMLDivElement>(null);
  const splitCleanupRef = useRef<(() => void) | null>(null);
  const pendingTabFocusRef = useRef<{ index: 0 | 1; mode: ReviewPanelMode } | null>(null);
  const [draggedMode, setDraggedMode] = useState<ReviewPanelMode | null>(null);
  const [dropPosition, setDropPosition] = useState<"top" | "bottom" | null>(null);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const isSplit = review.layout.modes.length === 2;
  const terminalPaneIndex = review.layout.modes.indexOf("terminal");
  const terminalMountIndex = (terminalPaneIndex >= 0 ? terminalPaneIndex : 0) as 0 | 1;

  useLayoutEffect(() => {
    const pending = pendingTabFocusRef.current;
    if (!pending || review.layout.modes[pending.index] !== pending.mode) return;
    pendingTabFocusRef.current = null;
    const label = `${pending.mode[0].toUpperCase()}${pending.mode.slice(1)}`;
    stackRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-pane-index="${pending.index}"] [role="tab"][aria-label="${label}"]`
      )
      ?.focus();
  }, [review.layout.modes]);

  useEffect(
    () => () => {
      splitCleanupRef.current?.();
      splitCleanupRef.current = null;
    },
    []
  );

  const clearTabDrag = (): void => {
    setDraggedMode(null);
    setDropPosition(null);
  };

  const handleTabDragStart = (
    mode: ReviewPanelMode,
    event: ReactDragEvent<HTMLButtonElement>
  ): void => {
    setDraggedMode(mode);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(REVIEW_MODE_DRAG_MIME, JSON.stringify({ mode, panelId: panelDragId }));
  };

  const acceptsCurrentDrag = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    draggedMode !== null && Array.from(event.dataTransfer.types).includes(REVIEW_MODE_DRAG_MIME);

  const updateDropPosition = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!acceptsCurrentDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropPosition(event.clientY < bounds.top + bounds.height / 2 ? "top" : "bottom");
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!acceptsCurrentDrag(event)) return;
    const position = dropPosition;
    let payload: { mode?: unknown; panelId?: unknown } | null = null;
    try {
      payload = JSON.parse(event.dataTransfer.getData(REVIEW_MODE_DRAG_MIME)) as {
        mode?: unknown;
        panelId?: unknown;
      };
    } catch {
      payload = null;
    }
    if (!position || payload?.panelId !== panelDragId || !isReviewPanelMode(payload.mode)) {
      clearTabDrag();
      return;
    }
    event.preventDefault();
    review.splitMode(payload.mode, position);
    clearTabDrag();
  };

  const handleDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const stack = stackRef.current;
    if (!stack) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setIsResizingSplit(true);
    const onMove = (moveEvent: PointerEvent): void => {
      const bounds = stack.getBoundingClientRect();
      if (bounds.height <= 0) return;
      review.setSplitRatio((moveEvent.clientY - bounds.top) / bounds.height);
    };
    const cleanup = (): void => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", cleanup);
      setIsResizingSplit(false);
      splitCleanupRef.current = null;
    };
    const onUp = (): void => cleanup();
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", cleanup);
    splitCleanupRef.current = cleanup;
  };

  const handleDividerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let ratio: number | null = null;
    if (event.key === "ArrowUp") ratio = review.layout.ratio - REVIEW_PANEL_RATIO_STEP;
    if (event.key === "ArrowDown") ratio = review.layout.ratio + REVIEW_PANEL_RATIO_STEP;
    if (event.key === "Home") ratio = MIN_REVIEW_SPLIT_RATIO;
    if (event.key === "End") ratio = MAX_REVIEW_SPLIT_RATIO;
    if (ratio === null) return;
    event.preventDefault();
    review.setSplitRatio(ratio);
  };

  return (
    <aside className="review-panel" data-type-scale="chrome" aria-label="Review panel">
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div
        className="review-panel-stack"
        data-split={isSplit ? "true" : "false"}
        role="group"
        aria-label="Review panes"
        ref={stackRef}
        onDragEnter={updateDropPosition}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDropPosition(null);
        }}
        onDragOver={updateDropPosition}
        onDrop={handleDrop}
      >
        {review.layout.modes.map((mode, rawIndex) => {
          const paneIndex = rawIndex as 0 | 1;
          const paneReview: ReviewState = {
            ...review,
            mode,
            closePanel: () => review.closePane(paneIndex),
            setMode: (nextMode) => {
              pendingTabFocusRef.current = nextMode === mode ? null : { index: paneIndex, mode: nextMode };
              review.setPaneMode(paneIndex, nextMode);
              if (nextMode === "browser") review.openBrowser();
            }
          };
          return (
            <ReviewPanelPane
              agents={agents}
              isFocused={isFocused && review.layout.activeIndex === paneIndex}
              isSplit={isSplit}
              key={mode}
              onAddDiffNote={onAddDiffNote}
              onTabDragEnd={clearTabDrag}
              onTabDragStart={handleTabDragStart}
              ownsTerminalMount={paneIndex === terminalMountIndex}
              paneIndex={paneIndex}
              paneSize={isSplit && paneIndex === 0 ? `calc(${review.layout.ratio * 100}% - 3px)` : undefined}
              review={paneReview}
            />
          );
        })}
        {isSplit ? (
          <div
            className="review-split-divider"
            role="separator"
            aria-label="Resize review panes"
            aria-orientation="horizontal"
            aria-valuemax={MAX_REVIEW_SPLIT_RATIO * 100}
            aria-valuemin={MIN_REVIEW_SPLIT_RATIO * 100}
            aria-valuenow={Math.round(review.layout.ratio * 100)}
            onKeyDown={handleDividerKeyDown}
            onPointerDown={handleDividerPointerDown}
            tabIndex={0}
          />
        ) : null}
        {draggedMode ? (
          <div className="review-split-drop-shield" data-browser-overlay="true">
            {dropPosition ? (
              <div className="review-split-drop-overlay" data-position={dropPosition} role="status">
                <span>{`Show ${draggedMode[0].toUpperCase()}${draggedMode.slice(1)} ${dropPosition === "top" ? "above" : "below"}`}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        {isResizingSplit ? (
          <div className="review-split-resize-shield" data-browser-overlay="true" aria-hidden="true" />
        ) : null}
      </div>
    </aside>
  );
}
