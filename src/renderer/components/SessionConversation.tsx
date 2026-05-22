import {
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  GitCommit,
  MoreHorizontal,
  Plus,
  Square,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  appendReferencesToPrompt,
  imageAttachmentReference
} from "../lib/composerAttachments.js";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  AgentMode,
  CheckRun,
  ComposerAttachment,
  GhPrRecord,
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useFreshSet } from "../hooks/useFreshSet.js";
import { MASCOT_BOB_MS, useMascotFlash } from "../hooks/useMascotFlash.js";
import { useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { modelSelectionFromSession, thinkingModelSlug } from "../lib/models.js";
import { parsePlan } from "../lib/parsePlan.js";
import { repoNameFromPath } from "../lib/projects.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import { buildTerminalTranscript } from "../lib/rawProvider.js";
import { DEFAULT_THINKING_STYLE, type ThinkingStyle } from "../lib/thinkingStyle.js";
import {
  AGENT_MODE_LABELS,
  readStoredAgentMode,
  sessionAgentModeKey,
  toggleAgentMode,
  writeStoredAgentMode
} from "../lib/agentMode.js";
import {
  detectToolError,
  extractCompletionCorrelationId,
  extractToolError,
  extractToolInput,
  extractToolInputPreview,
  extractToolName,
  extractToolOutput,
  extractToolUseId,
  type ToolCall
} from "../lib/toolCalls.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { GitActionsMenu } from "./GitActionsMenu.js";
import { ChatBubble } from "./ChatBubble.js";
import { CodeBlock } from "./CodeBlock.js";
import { CostPanel } from "./CostPanel.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { computeTurnModelHeaderMap } from "../lib/turnHeaderModel.js";
import { foldConversationItems, foldRenderItems, type RenderItem } from "../lib/foldConversation.js";
import { parseQuestionsFromToolInput } from "../lib/questions.js";
import {
  collectAskUserQuestionState,
  collectExitPlanState,
  hasOutstandingCardAsk as sessionHasOutstandingCardAsk
} from "../lib/turnInteractiveCards.js";
import {
  foldTurnToolItems,
  visibleTurnToolItem
} from "../lib/turnToolItems.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { FilePopover } from "./FilePopover.js";
import { Mascot } from "./Mascot.js";
import { ModelSelector } from "./ModelSelector.js";
import { PlanCard } from "./PlanCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { SkillPopover } from "./SkillPopover.js";
import { ThinkingTranscript } from "./ThinkingTranscript.js";

/** Terminate a running probe (if needed) then send follow-up input; surfaces errors. */
function sendAfterTerminate(
  sessionId: string,
  isRunning: boolean,
  onTerminateSession: (id: string) => Promise<void>,
  send: () => Promise<void>,
  onError: (message: string) => void
): void {
  const runSend = (): void => {
    void send().catch((error) => {
      onError(error instanceof Error ? error.message : "Could not send input.");
    });
  };
  if (isRunning) {
    void onTerminateSession(sessionId)
      .then(runSend)
      .catch((error) => {
        onError(error instanceof Error ? error.message : "Could not terminate session.");
      });
  } else {
    runSend();
  }
}
import { ThinkingVerbs } from "./ThinkingVerbs.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { TurnBlock, type TurnBodyChild, type TurnToolItem } from "./TurnBlock.js";

const PROMPT_MAX_HEIGHT_PX = 140;

function cursorAssistantSnapshot(event: TimelineEvent): string | null {
  if (event.type !== "message.delta" || event.payload.type !== "assistant") {
    return null;
  }
  const message = objectValue(event.payload.message);
  const content = arrayValue(message?.content);
  if (!content) {
    return null;
  }
  const text = content
    .map((entry) => stringValue(objectValue(entry)?.text))
    .filter((value): value is string => Boolean(value))
    .join("");
  return text || null;
}

function deltaTextForBuffer(event: TimelineEvent, currentText: string): string {
  const snapshot = cursorAssistantSnapshot(event);
  if (snapshot === null) {
    return event.message;
  }
  if (snapshot.startsWith(currentText)) {
    return snapshot.slice(currentText.length);
  }
  if (currentText.startsWith(snapshot)) {
    return "";
  }
  return event.message;
}

function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

function isSubAgentProseEcho(event: TimelineEvent): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed") return false;
  const parentToolUseId = event.payload.parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
}

function StreamingMarkdown({
  text,
  streaming,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  return (
    <div className={`markdown${streaming ? " markdown-streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...rest }) => {
            const hasLanguage = typeof className === "string" && className.includes("language-");
            const codeText = Array.isArray(children)
              ? children.map((c) => (typeof c === "string" ? c : "")).join("")
              : typeof children === "string"
                ? children
                : "";
            // Fenced blocks (language-tagged or bare ``` with newlines) route to
            // CodeBlock so the <pre> wrapper survives the pre: <>{children}</> override.
            if (hasLanguage || codeText.includes("\n")) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            const match = matchFileChip(codeText);
            if (match) {
              return (
                <FileChip
                  path={match.path}
                  line={match.line}
                  workspaceId={workspace?.id ?? null}
                  workspaceCwd={workspace?.path ?? null}
                  onOpen={onOpenFile}
                />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          a: ({ href, children, ...rest }) => {
            if (!href || href.startsWith("#")) {
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            }
            // External links open in the user's default browser via
            // main.ts setWindowOpenHandler -> shell.openExternal.
            if (/^(?:https?:|mailto:)/.test(href)) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            }
            const match = matchFileChip(href);
            if (!match) {
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            }
            return (
              <FileChip
                path={match.path}
                line={match.line}
                workspaceId={workspace?.id ?? null}
                workspaceCwd={workspace?.path ?? null}
                onOpen={onOpenFile}
              />
            );
          },
          pre: ({ children }) => <>{children}</>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  events,
  isLogOpen,
  onClose,
  onOpenCommitDialog,
  onSendSessionInput,
  onCancelQueuedMessage,
  pendingMessages = [],
  onTerminateSession,
  onCreateCheckpoint,
  onRunCheck,
  onToggleLog,
  onOpenFile,
  pendingApprovalCount = 0,
  project,
  rawOutputs,
  review,
  session,
  showCostPanel = true,
  thinkingStyle = DEFAULT_THINKING_STYLE,
  workspace
}: {
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  defaultToolCallGroupsExpanded?: boolean;
  events: TimelineEvent[];
  isLogOpen: boolean;
  /** When provided, a close (×) button is rendered in the header — used by the multi-pane grid. */
  onClose?: () => void;
  onOpenCommitDialog?: () => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ProviderModelSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  /** Follow-ups composed while the agent was running. Render as cancellable
      chips above the composer; cleared from the parent as the queue drains. */
  pendingMessages?: PendingMessage[];
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onToggleLog: () => void;
  /** Called when the user clicks a file reference inside agent text. When
      provided, the chip routes to the in-app right panel by default, with
      ⌘/Ctrl-click flagged via `preferIde` for the external IDE shortcut. */
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  pendingApprovalCount?: number;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  showCostPanel?: boolean;
  thinkingStyle?: ThinkingStyle;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [prs, setPrs] = useState<GhPrRecord[]>([]);
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>(() => modelSelectionFromSession(session));
  const [agentMode, setAgentMode] = useState<AgentMode>(() =>
    session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "auto") : "auto"
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const shouldRefocusInput = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsMode, setActionsMode] = useState<"main" | "git">("main");
  const [actionsPos, setActionsPos] = useState<{ top: number; right: number } | null>(null);
  const actionsAnchorRef = useRef<HTMLDivElement | null>(null);
  const actionsPopoverRef = useRef<HTMLDivElement | null>(null);
  const closeActions = useCallback(() => {
    setActionsOpen(false);
    setActionsMode("main");
  }, []);
  useDismissOnOutsideOrEscape(actionsAnchorRef, actionsOpen, closeActions, actionsPopoverRef);
  useLayoutEffect(() => {
    if (!actionsOpen) {
      setActionsPos(null);
      return;
    }
    const anchor = actionsAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setActionsPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right)
    });
  }, [actionsOpen]);
  const sessionId = session?.id ?? null;
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(
    () => {
      const ascending = events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            !isPayloadTruncationMarker(event) &&
            !isSubAgentProseEcho(event) &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .reverse();
      // Providers stream message.delta fragments and then a final message.completed
      // with the accumulated text. Once a turn has a completed event, the deltas
      // are stale duplicates — keep them only while streaming (before completion).
      return ascending.filter((event, index) => {
        if (event.type !== "message.delta") return true;
        for (let next = index + 1; next < ascending.length; next++) {
          const nextEvent = ascending[next];
          if (!nextEvent) break;
          if (nextEvent.type === "user.message") return true;
          if (nextEvent.type === "message.completed") return false;
        }
        return true;
      });
    },
    [events]
  );
  // Hide the raw-stdout fallback as soon as ANY renderable content exists —
  // a streamed message OR a tool call. Otherwise the agent's first beat (often
  // a tool_use before any text) flashes the raw provider JSONL through the
  // gray .chat-bubble.terminal-transcript pre while normalized events catch up.
  const hasRenderableContent =
    conversationEvents.some((event) => event.type !== "user.message") ||
    events.some((event) => event.type === "command.started");
  const terminalTranscript = useMemo(
    () => (hasRenderableContent ? "" : buildTerminalTranscript(rawOutputs, session?.id ?? null)),
    [rawOutputs, session?.id, hasRenderableContent]
  );

  const toolCalls = useMemo((): ToolCall[] => {
    const starts = new Map<string, { event: TimelineEvent; toolUseId: string }>();
    const completions = new Map<string, TimelineEvent>();
    for (const event of events) {
      if (event.type === "command.started") {
        const toolUseId = extractToolUseId(event.payload) ?? event.id;
        starts.set(toolUseId, { event, toolUseId });
      } else if (event.type === "command.completed") {
        const toolUseId = extractCompletionCorrelationId(event.payload);
        if (toolUseId) completions.set(toolUseId, event);
      }
    }
    return [...starts.values()]
      .map(({ event, toolUseId }) => {
        const name = extractToolName(event.payload);
        const completion = completions.get(toolUseId);
        const startInput = extractToolInput(event.payload);
        const completionInput = completion ? extractToolInput(completion.payload) : {};
        const input = Object.keys(startInput).length > 0 ? startInput : completionInput;
        const isError = completion ? detectToolError(completion.payload) : false;
        const status: ToolCall["status"] = !completion ? "running" : isError ? "error" : "done";
        return {
          id: event.id,
          toolUseId,
          name,
          inputPreview: extractToolInputPreview(name, input),
          inputFull: input,
          output: completion ? extractToolOutput(completion.payload) : null,
          status,
          createdAt: event.createdAt,
          completedAt: completion ? completion.createdAt : null,
          error: completion && isError ? extractToolError(completion.payload) : null
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events]);

  const conversationItems = useMemo(
    () => foldConversationItems(conversationEvents, toolCalls),
    [conversationEvents, toolCalls]
  );

  const isFreshTool = useFreshSet(toolCalls, (tool) => tool.id, session?.id ?? "");

  const renderItems = useMemo(
    (): RenderItem[] => foldRenderItems(conversationItems, session, foldTurnToolItems),
    [conversationItems, session]
  );

  // Composer is enabled whenever the session is alive — `running` no longer
  // blocks: typed messages get queued in main and drain when the current turn
  // finishes. `complete` and `cancelled` are also enabled because main's
  // sendInput re-launches the agent when no live handle exists, so the user
  // can keep chatting after a turn ends or they hit Stop.
  const canSend = Boolean(
    session && ["complete", "waiting", "running", "cancelled"].includes(session.state)
  );
  // Currently running → the next submit goes onto the queue rather than
  // straight to the agent. Used to tweak placeholder and Send tooltip copy.
  const isQueueing = session?.state === "running";
  const lastSignificantEvent = events.find(
    (event) =>
      event.payload.raw !== true &&
      (event.type === "user.message" ||
        event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.started" ||
        event.type === "command.completed")
  );
  // Show the "Thinking" bubble whenever the session is running and there is
  // no other live progress indicator on screen. The two indicators that
  // already convey "work is happening" are:
  //   (a) the streaming caret on an actively-deltaing message bubble, and
  //   (b) the running spinner on a visible tool row.
  // Between events — say, after a `message.completed` while the model is
  // deciding the next tool — neither (a) nor (b) is on, and the chat would
  // otherwise sit silent. Show Thinking there. Also: the `ExitPlanMode` /
  // `AskUserQuestion` tools are *hidden* (rendered as cards), so a running
  // instance of either gives no on-screen indicator either; treat them as
  // "no visible tool running" and let Thinking show.
  const isStreamingMessage = lastSignificantEvent?.type === "message.delta";
  const anyVisibleToolRunning = useMemo(
    () =>
      toolCalls.some(
        (tool) =>
          tool.status === "running" &&
          tool.name !== "ExitPlanMode" &&
          (tool.name !== "AskUserQuestion" || !parseQuestionsFromToolInput(tool))
      ),
    [toolCalls]
  );
  // An interactive card (Plan or Question) outstanding means the agent has
  // handed the turn over to the user — even if the probe is still alive
  // briefly emitting fallback text. From the user's perspective the agent
  // is *waiting*, not thinking. Suppress Thinking until the user submits
  // (which lands a new `user.message`, advancing `lastUserMessageTime` past
  // the tool's `createdAt`).
  const hasOutstandingCardAsk = useMemo(
    () => sessionHasOutstandingCardAsk(events, toolCalls),
    [events, toolCalls]
  );
  const isThinking =
    session?.state === "running" &&
    !anyVisibleToolRunning &&
    !isStreamingMessage &&
    !hasOutstandingCardAsk;

  const {
    conversationListRef,
    metaCardsRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom: scrollConversationToBottom,
    handleScroll: handleConversationScroll
  } = useSmartFollowScroll(sessionId, conversationItems, isThinking);
  const { happyFlashUntilMs, justSentAt, markSent } = useMascotFlash(sessionId ?? null, events);
  const {
    pendingAttachments,
    attachmentInputRef,
    removePendingAttachment,
    onComposerDragOver,
    onComposerDrop,
    onComposerPaste,
    onAttachmentInputChange,
    openFilePicker,
    clearAttachments
  } = useComposerAttachments({
    sessionId,
    workspacePath: workspace?.path ?? null,
    setInput,
    setStatus
  });
  const repositoryName = project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";

  // Depend on session.id rather than the session object: the parent rebuilds
  // SessionSummary references on every dashboard delta, which would otherwise
  // overwrite the user's per-session model pick on every streaming event.
  useEffect(() => {
    setSelectedModel(modelSelectionFromSession(session));
    setAgentMode(session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "auto") : "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.id is the identity gate; `session` mutates per-tick by design
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    writeStoredAgentMode(sessionAgentModeKey(sessionId), agentMode);
  }, [agentMode, sessionId]);

  const toggleMode = useCallback((): void => {
    setAgentMode((mode) => toggleAgentMode(mode));
  }, []);

  // Cached PR rows for the git-actions dropdown. Cheap (DB-backed), so we just
  // reload on session change. The dropdown's "view PR" action calls back via
  // refreshPrs after creating a PR so the next click opens the existing one.
  useEffect(() => {
    if (!sessionId || !window.argmax) {
      setPrs([]);
      return;
    }
    let cancelled = false;
    void window.argmax.prs
      .listForSession({ sessionId })
      .then((rows) => {
        if (!cancelled) setPrs(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setPrs([]);
        setStatus(error instanceof Error ? error.message : "Could not load pull requests.");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const refreshPrs = useCallback((): void => {
    if (!sessionId || !window.argmax) return;
    void window.argmax.prs
      .listForSession({ sessionId })
      .then(setPrs)
      .catch((error) => {
        setPrs([]);
        setStatus(error instanceof Error ? error.message : "Could not refresh pull requests.");
      });
  }, [sessionId]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, isSending]);

  // Auto-focus the chat input when the session view is the active surface —
  // on mount, when the session becomes sendable, and again whenever the
  // right-side review panel closes, so typing resumes without a click.
  useEffect(() => {
    if (review.isPanelOpen || isSending || !canSend) return;
    inputRef.current?.focus();
  }, [review.isPanelOpen, canSend, isSending]);

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null
  });

  const fileAutocomplete = useFileAutocomplete({
    input,
    setInput,
    inputRef,
    source: workspace ? { kind: "workspace", id: workspace.id } : null
  });

  useAutoGrowTextArea(inputRef, input, PROMPT_MAX_HEIGHT_PX);

  const onSessionInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    fileAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Tab" && event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      toggleMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      inputFormRef.current?.requestSubmit();
    }
  };

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending) {
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const prompt = refs.length > 0 ? appendReferencesToPrompt(trimmedInput, refs) : trimmedInput;
    const attachmentsForPersist: ComposerAttachment[] = pendingAttachments.map((a) => ({
      filePath: a.filePath,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes
    }));

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    markSent();
    try {
      await onSendSessionInput(
        session.id,
        prompt,
        selectedModel,
        agentMode,
        attachmentsForPersist.length > 0 ? attachmentsForPersist : undefined
      );
      setInput("");
      clearAttachments();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <section className="conversation-surface" aria-label="Session conversation">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Repository</p>
          <h2>{repositoryName}</h2>
        </div>
        <div className="conversation-header-actions">
          <div className="session-actions-anchor" ref={actionsAnchorRef}>
            <button
              className="small-icon"
              type="button"
              title="Session actions"
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </button>
            {actionsOpen && actionsPos && createPortal(
              <div
                ref={actionsPopoverRef}
                className="project-picker-popover session-actions-popover"
                role="menu"
                aria-label="Session actions"
                style={{
                  position: "fixed",
                  top: actionsPos.top,
                  right: actionsPos.right,
                  left: "auto",
                  bottom: "auto"
                }}
              >
                {actionsMode === "main" && (
                  <ul className="session-actions-list">
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        disabled={!workspace}
                        onClick={() => {
                          closeActions();
                          review.openPanelInFilesMode();
                        }}
                      >
                        <Folder size={14} aria-hidden="true" />
                        Browse files
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item"
                        title={
                          workspace?.dirty
                            ? "Save checkpoint of the current worktree"
                            : "Worktree is clean — no checkpoint needed"
                        }
                        disabled={!workspace?.dirty}
                        onClick={() => {
                          if (!workspace) return;
                          closeActions();
                          void onCreateCheckpoint(workspace.id);
                        }}
                      >
                        <GitCommit size={14} aria-hidden="true" />
                        Save checkpoint
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="project-picker-item session-actions-submenu-trigger"
                        aria-haspopup="menu"
                        disabled={!workspace}
                        onClick={() => setActionsMode("git")}
                      >
                        <GitBranch size={14} aria-hidden="true" />
                        <span className="session-actions-submenu-label">Git actions</span>
                        <ChevronRight size={14} aria-hidden="true" className="session-actions-submenu-chevron" />
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        className="project-picker-item"
                        aria-checked={isLogOpen}
                        onClick={onToggleLog}
                      >
                        <Bug size={14} aria-hidden="true" />
                        Toggle debug log
                      </button>
                    </li>
                  </ul>
                )}
                {actionsMode === "git" && (
                  <div className="session-actions-submenu">
                    <button
                      type="button"
                      className="session-actions-back"
                      aria-label="Back to session actions"
                      onClick={() => setActionsMode("main")}
                    >
                      <ChevronLeft size={12} aria-hidden="true" />
                      Back
                    </button>
                    <GitActionsMenu
                      prs={prs}
                      session={session}
                      workspace={workspace}
                      onPrsRefresh={refreshPrs}
                      onOpenCommitDialog={onOpenCommitDialog}
                      onClose={closeActions}
                    />
                  </div>
                )}
              </div>,
              document.body
            )}
          </div>
          {onClose ? (
            <button
              className="small-icon session-pane-close"
              type="button"
              title="Close pane (⌘W)"
              aria-label="Close pane"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="conversation-list" ref={conversationListRef} onScroll={handleConversationScroll}>
        {renderItems.length > 0 ? (
          (() => {
            const turnShowsModelHeader = computeTurnModelHeaderMap(renderItems, selectedModel.label);
            return renderItems.map((item, index) => {
            if (item.kind === "user-message") {
              const rawAttachments = arrayValue(item.event.payload.attachments) ?? [];
              const attachments = rawAttachments
                .map((entry) => {
                  const obj = objectValue(entry);
                  const filePath = stringValue(obj?.filePath);
                  const mimeType = stringValue(obj?.mimeType);
                  if (!filePath || !mimeType) return null;
                  return { filePath, mimeType };
                })
                .filter((value): value is { filePath: string; mimeType: string } => Boolean(value));
              // Strip the `@/abs/path` refs we appended in submitInput so the
              // bubble shows the user's prose, not the synthetic filesystem
              // pointer that's only there for the provider's file tool.
              let displayMessage = item.event.message;
              for (const a of attachments) {
                displayMessage = displayMessage.split(`@${a.filePath}`).join("");
              }
              displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
              return (
                <ChatBubble
                  key={item.event.id}
                  kind="user"
                  rawMarkdown={displayMessage}
                >
                  {attachments.length > 0 ? (
                    <div className="user-message-attachments" aria-label="Attached images">
                      {attachments.map((a) => {
                        const filename = a.filePath.split("/").pop() || a.filePath;
                        return (
                          <span
                            key={a.filePath}
                            className="user-message-attachment-chip"
                            title={a.filePath}
                          >
                            {filename}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {displayMessage ? <p>{displayMessage}</p> : null}
                </ChatBubble>
              );
            }
            // Coalesce consecutive `message.delta` events into a single
            // running bubble. Without this, Cursor's --stream-partial-output
            // would render a separate bubble per token. The buffer flushes on
            // the next non-delta event (typically `message.completed`).
            const assistantGroups: Array<{ id: string; createdAt: string; text: string; streaming: boolean }> = [];
            let deltaBuffer: { id: string; createdAt: string; text: string } | null = null;
            for (const event of item.assistantEvents) {
              if (event.type === "message.delta") {
                if (!deltaBuffer) deltaBuffer = { id: event.id, createdAt: event.createdAt, text: "" };
                deltaBuffer.text += deltaTextForBuffer(event, deltaBuffer.text);
                continue;
              }
              if (deltaBuffer) {
                assistantGroups.push({
                  id: deltaBuffer.id,
                  createdAt: deltaBuffer.createdAt,
                  text: deltaBuffer.text,
                  streaming: true
                });
                deltaBuffer = null;
              }
              assistantGroups.push({
                id: event.id,
                createdAt: event.createdAt,
                text: event.message,
                streaming: false
              });
            }
            if (deltaBuffer) {
              assistantGroups.push({
                id: deltaBuffer.id,
                createdAt: deltaBuffer.createdAt,
                text: deltaBuffer.text,
                streaming: true
              });
            }
            // Plan-mode replies render as a structured PlanCard. The
            // agentMode for *this* turn is the one captured on the preceding
            // user.message at send time — not the live picker, which may have
            // since toggled. Streaming groups fall through to ChatBubble until
            // completion so the card never appears half-rendered.
            const priorItem = index > 0 ? renderItems[index - 1] : null;
            const turnAgentMode: string | null =
              priorItem && priorItem.kind === "user-message"
                ? stringValue(priorItem.event.payload.agentMode)
                : null;
            // Claude Code emits the plan through its ExitPlanMode tool, not
            // assistant text. The structured plan markdown lives at
            // payload.input.plan; the surrounding narrative bubbles are just
            // commentary. When the tool fires, it's authoritative.
            // Collect every ExitPlanMode tool id up front — regardless of
            // status — so the raw tool row is hidden from the moment the tool
            // fires, not after completion. Otherwise the row flashes visible
            // for the ~20ms between `command.started` and `command.completed`.
            const { tool: exitPlanTool, hiddenToolIds: exitPlanToolIds } = collectExitPlanState(
              item.toolItems
            );
            const handlePlanAccept = (): void => {
              if (!session) return;
              setAgentMode("auto");
              writeStoredAgentMode(sessionAgentModeKey(session.id), "auto");
              shouldRefocusInput.current = true;
              // The probe may still be alive emitting fallback narration
              // after a denied ExitPlanMode. The user has accepted the plan;
              // anything the previous probe is still saying is stale. Kill
              // it so the answer doesn't sit in the queue waiting for that
              // narration to finish, then send. Main's sendInput relaunches
              // the agent when no live handle exists.
              const sessionId = session.id;
              sendAfterTerminate(
                sessionId,
                session.state === "running",
                onTerminateSession,
                () => onSendSessionInput(sessionId, "Proceed with the plan above.", selectedModel, "auto"),
                setStatus
              );
            };
            const handlePlanReject = (): void => {
              inputRef.current?.focus();
            };
            // Claude Code's AskUserQuestion tool can't be answered in
            // structured-json mode (no interactive stdin) — the tool errors
            // out, but its input still carries the structured question +
            // options. Render that as an interactive card so the user can
            // pick an answer; the chosen value is sent as a follow-up user
            // message (the model already remembers what it asked).
            // Walk every AskUserQuestion attempt in the turn. Render only the
            // most recent (the model's final, refined ask), but hide the raw
            // tool rows for every attempt so the UI shows one card, not a
            // pile of denied-tool rows above it.
            const { tool: askUserQuestionTool, hiddenToolIds: askUserQuestionToolIds } =
              collectAskUserQuestionState(item.toolItems);
            const handleQuestionAnswer = (answerMarkdown: string): void => {
              if (!session) return;
              shouldRefocusInput.current = true;
              // Same pattern as handlePlanAccept: terminate the probe first if
              // it's still alive emitting fallback text after a denied
              // AskUserQuestion. Otherwise the answer gets queued behind that
              // narration and the user waits for the probe to die naturally.
              const sessionId = session.id;
              const nextAgentMode = turnAgentMode === "plan" ? "plan" : "auto";
              sendAfterTerminate(
                sessionId,
                session.state === "running",
                onTerminateSession,
                () => onSendSessionInput(sessionId, answerMarkdown, selectedModel, nextAgentMode),
                setStatus
              );
            };
            const questionCard: JSX.Element | null = askUserQuestionTool
              ? (
                  <QuestionCard
                    key={`question-${askUserQuestionTool.id}`}
                    questions={askUserQuestionTool.questions}
                    createdAt={askUserQuestionTool.createdAt}
                    modelLabel={selectedModel.label}
                    onAnswer={handleQuestionAnswer}
                  />
                )
              : null;
            const exitPlanCard: JSX.Element | null = exitPlanTool
              ? (() => {
                  const plan = parsePlan(exitPlanTool.markdown);
                  if (!plan) return null;
                  return (
                    <PlanCard
                      key={`plan-${exitPlanTool.id}`}
                      plan={plan}
                      createdAt={exitPlanTool.createdAt}
                      rawMarkdown={exitPlanTool.markdown}
                      modelLabel={selectedModel.label}
                      onAccept={handlePlanAccept}
                      onReject={handlePlanReject}
                    />
                  );
                })()
              : null;
            // Narrative-text plan path (Codex / Cursor). Skip when an
            // ExitPlanMode card already rendered — Claude's narrative
            // bubbles should remain as plain text alongside the card.
            const tryRenderPlan = (
              group: { id: string; createdAt: string; text: string; streaming: boolean }
            ): JSX.Element | null => {
              if (exitPlanCard) return null;
              if (turnAgentMode !== "plan" || group.streaming) return null;
              const plan = parsePlan(group.text);
              if (!plan) return null;
              return (
                <PlanCard
                  key={group.id}
                  plan={plan}
                  createdAt={group.createdAt}
                  rawMarkdown={group.text}
                  modelLabel={selectedModel.label}
                  onAccept={handlePlanAccept}
                  onReject={handlePlanReject}
                />
              );
            };
            // When a PlanCard or QuestionCard is the turn's authoritative
            // artifact, hide assistant text that arrives AFTER the tool fired.
            // In structured-json mode both tools error out and the model often
            // confabulates a fallback: re-emitting the plan as a chat bubble
            // (PlanCard) or hallucinating a "Thanks based on your input"
            // message with fake answers BEFORE the user has touched the card
            // (QuestionCard). Either way the card already conveys the ask;
            // the fallback prose is noise at best, misleading at worst. The
            // cutoff is per-turn — the user's submitted answer creates a new
            // user.message and a new turn, so genuine follow-up scan results
            // still come through unblocked.
            const cardCutoffs = [
              exitPlanCard && exitPlanTool ? exitPlanTool.createdAt : null,
              questionCard && askUserQuestionTool ? askUserQuestionTool.createdAt : null
            ].filter((t): t is string => t !== null);
            const cardCutoff = cardCutoffs.length > 0 ? cardCutoffs.reduce((a, b) => (a < b ? a : b)) : null;
            const visibleAssistantGroups = cardCutoff
              ? assistantGroups.filter((g) => g.createdAt < cardCutoff)
              : assistantGroups;
            type AnnotatedChild = TurnBodyChild & { createdAt: string };
            const assistantChildren: AnnotatedChild[] = visibleAssistantGroups.map((group) => {
              const planNode = tryRenderPlan(group);
              if (planNode) {
                return { kind: "assistant", id: group.id, node: planNode, createdAt: group.createdAt };
              }
              const node = (
                <ChatBubble
                  key={group.id}
                  kind="assistant"
                  rawMarkdown={group.text}
                >
                  <StreamingMarkdown
                    text={group.text}
                    streaming={group.streaming}
                    workspace={workspace}
                    onOpenFile={onOpenFile}
                  />
                </ChatBubble>
              );
              return { kind: "assistant", id: group.id, node, createdAt: group.createdAt };
            });
            // Insert the ExitPlanMode card alongside the narrative bubbles so
            // it interleaves chronologically with everything else in the turn.
            if (exitPlanCard && exitPlanTool) {
              assistantChildren.push({
                kind: "assistant",
                id: `plan-${exitPlanTool.id}`,
                node: exitPlanCard,
                createdAt: exitPlanTool.createdAt
              });
            }
            if (questionCard && askUserQuestionTool) {
              assistantChildren.push({
                kind: "assistant",
                id: `question-${askUserQuestionTool.id}`,
                node: questionCard,
                createdAt: askUserQuestionTool.createdAt
              });
            }
            const hiddenToolIds = new Set([...exitPlanToolIds, ...askUserQuestionToolIds]);
            const visibleToolItems = item.toolItems
              .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
              .filter((tItem): tItem is TurnToolItem => tItem !== null);
            // A turn's tool groups stay expanded only while that turn is
            // "active": a tool is still running, or it's the last turn in the
            // list and the session is still streaming. Past turns collapse
            // regardless of the global "Show expanded" setting; the active
            // turn falls back to the global setting.
            const isLatestTurn = index === renderItems.length - 1;
            const anyToolRunningInTurn = visibleToolItems.some((tItem) =>
              tItem.kind === "tool"
                ? tItem.tool.status === "running"
                : tItem.group.tools.some((tool) => tool.status === "running")
            );
            const sessionIsLive = session?.state === "running";
            const turnIsActive = anyToolRunningInTurn || (isLatestTurn && sessionIsLive);
            // The agent is "paused on user input" once a QuestionCard or
            // PlanCard renders — those cards take over the UI and the model
            // is blocked until the user acts. We stop the live ticker here so
            // the chip doesn't keep counting wall-clock time the agent isn't
            // actually spending.
            const isPausedOnUserInput = askUserQuestionTool !== null || exitPlanTool !== null;
            const isTurnLiveTicking = isLatestTurn && sessionIsLive && !isPausedOnUserInput;
            // Prefer the preceding user.message timestamp as turn start — that's
            // when the agent began working from the user's perspective, even
            // before the first tool or assistant token lands. Fall back to the
            // earliest in-turn signal if there's no prior user message.
            let turnStartedAtMs = Number.NaN;
            if (priorItem && priorItem.kind === "user-message") {
              const parsed = Date.parse(priorItem.event.createdAt);
              if (Number.isFinite(parsed)) turnStartedAtMs = parsed;
            }
            if (!Number.isFinite(turnStartedAtMs)) {
              let earliest = Number.POSITIVE_INFINITY;
              for (const ts of item.assistantTimestamps) {
                if (Number.isFinite(ts)) earliest = Math.min(earliest, ts);
              }
              for (const tItem of item.toolItems) {
                const tools = tItem.kind === "tool" ? [tItem.tool] : tItem.group.tools;
                for (const t of tools) {
                  const s = Date.parse(t.createdAt);
                  if (Number.isFinite(s)) earliest = Math.min(earliest, s);
                }
              }
              if (Number.isFinite(earliest)) turnStartedAtMs = earliest;
            }
            // The inner toggle controls whether each tool group bubble and
            // standalone tool row reveals its detail body by default. While
            // the turn is live the rows still auto-expand so the user can see
            // streaming output regardless of this preference; after the turn
            // completes the row's own user toggle takes over.
            const groupDefaultExpanded = turnIsActive
              ? (defaultToolCallGroupsExpanded ?? defaultToolCallsExpanded)
              : false;
            const toolChildren: AnnotatedChild[] = visibleToolItems
              .map((tItem) => {
              if (tItem.kind === "tool") {
                return {
                  kind: "tool",
                  id: tItem.tool.id,
                  createdAt: tItem.tool.createdAt,
                  node: (
                    <ToolCallRow
                      tool={tItem.tool}
                      defaultExpanded={groupDefaultExpanded}
                      workspaceCwd={workspace?.path ?? null}
                    />
                  )
                };
              }
              const firstCreatedAt = tItem.group.tools[0]?.createdAt ?? "";
              return {
                kind: "tool",
                id: tItem.group.id,
                createdAt: firstCreatedAt,
                node: (
                  <ToolCallGroupBubble
                    group={tItem.group}
                    isFreshTool={isFreshTool}
                    defaultExpanded={groupDefaultExpanded}
                    workspaceCwd={workspace?.path ?? null}
                  />
                )
              };
            });
            // Interleave assistant text and tool runs by createdAt so the chat
            // reads chronologically — without this, every tool call drifts to
            // the bottom of the turn once the assistant text lands above it.
            const bodyChildren: TurnBodyChild[] = [...assistantChildren, ...toolChildren]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map(({ kind, id, node }) => ({ kind, id, node }));
            // Earliest assistant or tool createdAt in the turn — used as the
            // single canonical timestamp shown in the turn header. Per-paragraph
            // timestamps inside this turn are visually suppressed.
            const earliestCreatedAt = [...assistantChildren, ...toolChildren]
              .map((c) => c.createdAt)
              .filter((t): t is string => typeof t === "string" && t.length > 0)
              .sort()[0];
            const showModelHeader = turnShowsModelHeader.get(index) ?? false;
            return (
              <TurnBlock
                key={item.id}
                toolItems={visibleToolItems}
                assistantTimestamps={item.assistantTimestamps}
                {...(showModelHeader ? { modelLabel: selectedModel.label } : {})}
                {...(defaultToolCallsExpanded !== undefined ? { defaultExpanded: defaultToolCallsExpanded } : {})}
                {...(Number.isFinite(turnStartedAtMs) ? { turnStartedAtMs } : {})}
                isTurnActive={isTurnLiveTicking}
                body={bodyChildren}
                {...(earliestCreatedAt ? { headerTimestampIso: earliestCreatedAt } : {})}
              />
            );
            });
          })()
        ) : terminalTranscript ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : isThinking ? null : (
          <p className="conversation-empty">Agent replies will appear here.</p>
        )}
        {terminalTranscript && !hasRenderableContent && conversationItems.length > 0 ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : null}
        {showScrollToBottom ? (
          <button
            type="button"
            className="scroll-to-bottom-fab"
            data-has-count={newBelowCount > 0 ? "true" : "false"}
            aria-label={newBelowCount > 0 ? `${newBelowCount} new — scroll to latest` : "Scroll to latest"}
            title={newBelowCount > 0 ? `${newBelowCount} new` : "Scroll to latest"}
            onClick={scrollConversationToBottom}
          >
            <ChevronDown size={16} aria-hidden="true" />
            {newBelowCount > 0 ? (
              <span className="scroll-to-bottom-fab-count">{newBelowCount} new</span>
            ) : null}
          </button>
        ) : null}
        {isThinking ? (
          thinkingStyle === "verbs" ? (
            <ThinkingVerbs />
          ) : (
            <ThinkingTranscript command={`run --model ${thinkingModelSlug(selectedModel)}`} />
          )
        ) : null}
      </div>
      <div
        className="session-meta-cards"
        data-cost-visible={session && showCostPanel ? "true" : "false"}
        ref={metaCardsRef}
      >
        <ChangedFilesCard
          review={review}
          workspaceId={workspace?.id}
          checkCommands={project?.settings.checkCommands ?? []}
          checks={checks ?? []}
          onRunCheck={onRunCheck}
        />
        {session && showCostPanel ? <CostPanel session={session} /> : null}
      </div>
      {pendingApprovalCount > 0 ? (
        <div className="composer-approvals-banner" role="status" aria-live="polite">
          <span className="composer-approvals-banner-count" aria-hidden="true">{pendingApprovalCount}</span>
          <span>
            {pendingApprovalCount === 1 ? "approval needs review" : "approvals need review"}
          </span>
          <button
            type="button"
            className="composer-approvals-banner-cta"
            aria-label="Scroll to approvals"
            onClick={() => {
              // Scope the query to *this* conversation's list — otherwise a
              // multi-grid view with several panes scrolls to whichever
              // approval-surface document.querySelector returns first.
              const root = conversationListRef.current;
              const el = root?.querySelector(".approval-surface");
              if (el instanceof HTMLElement) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            }}
          >
            Review
          </button>
        </div>
      ) : null}
      <form
        className="session-input"
        ref={inputFormRef}
        onSubmit={(event) => void submitInput(event)}
        onDragOver={onComposerDragOver}
        onDrop={onComposerDrop}
      >
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 ? (
          <div className="composer-attachments" aria-label="Attached images">
            {pendingAttachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-chip">
                <img src={attachment.thumbnailDataUrl} alt="" />
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  onClick={() => removePendingAttachment(attachment.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {pendingMessages.length > 0 ? (
          <div className="composer-queued-lane" role="list" aria-label="Queued follow-ups">
            {pendingMessages.map((entry) => {
              const cancel = (): void => {
                if (!session || !onCancelQueuedMessage) return;
                void onCancelQueuedMessage(session.id, entry.id).catch(() => undefined);
              };
              return (
                <div
                  key={entry.id}
                  className="composer-queued-chip"
                  role="listitem"
                  tabIndex={0}
                  title={entry.content}
                  aria-label={`Queued follow-up: ${entry.content}`}
                  onKeyDown={(event) => {
                    if (event.key === "Backspace" || event.key === "Delete") {
                      event.preventDefault();
                      cancel();
                    }
                  }}
                >
                  <span className="composer-queued-chip-label">{entry.content}</span>
                  <button
                    type="button"
                    className="composer-queued-chip-remove"
                    aria-label="Cancel queued follow-up"
                    title="Cancel queued follow-up"
                    onClick={cancel}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="session-input-field">
          <textarea
            aria-label="Session prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
            aria-controls={
              slashAutocomplete.popoverOpen
                ? "skill-popover"
                : fileAutocomplete.popoverOpen
                  ? "file-popover"
                  : undefined
            }
            disabled={!canSend || isSending}
            onChange={(event) => {
              setInput(event.target.value);
              fileAutocomplete.onSelectionChange(event);
            }}
            onKeyDown={onSessionInputKeyDown}
            onPaste={onComposerPaste}
            onSelect={fileAutocomplete.onSelectionChange}
            onClick={fileAutocomplete.onSelectionChange}
            placeholder={
              canSend
                ? isQueueing
                  ? "Queue a follow-up — sent when the current turn finishes"
                  : "Reply to your agent, or @-mention files"
                : ""
            }
            ref={inputRef}
            value={input}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
          <FilePopover state={fileAutocomplete} inputRef={inputRef} />
        </div>
        <div className="session-input-toolbar">
          <button
            className="composer-tool"
            type="button"
            title="Attach file"
            aria-label="Attach file"
            disabled={!canSend || isSending}
            onClick={openFilePicker}
          >
            <Plus size={16} />
          </button>
          {session ? (
            <div className="composer-chips-group composer-chips-model">
              <ModelSelector
                provider={session.provider}
                value={selectedModel}
                onChange={setSelectedModel}
                ariaLabel="Session model"
              />
            </div>
          ) : null}
          {session ? (
            <div className="composer-chips-group composer-chips-mode">
              <button
                type="button"
                className="composer-context-chip agent-mode-toggle"
                aria-label="Agent mode"
                aria-pressed={agentMode === "plan"}
                title="Toggle agent mode (Shift+Tab)"
                disabled={!canSend || isSending}
                onClick={toggleMode}
              >
                {AGENT_MODE_LABELS[agentMode]}
              </button>
            </div>
          ) : null}
          {workspace ? (
            <div className="composer-footer composer-chips-group composer-chips-context" aria-label="Workspace context">
              {workspace.sharedWorkspace ? null : (
                <button
                  type="button"
                  className="composer-footer-chip"
                  title={`Open worktree: ${workspace.path}`}
                  aria-label={`Open worktree at ${workspace.path}`}
                  onClick={() => {
                    if (!window.argmax) return;
                    void window.argmax.system.openPath({ path: workspace.path }).catch(() => undefined);
                  }}
                >
                  <Folder size={11} aria-hidden="true" />
                  <span>Worktree</span>
                </button>
              )}
              <button
                type="button"
                className="composer-footer-chip"
                title={`Branch: ${workspace.branch}`}
                aria-label={`Branch ${workspace.branch}`}
              >
                <GitBranch size={11} aria-hidden="true" />
                <span>{workspace.branch}</span>
              </button>
            </div>
          ) : null}
          <span className="session-toolbar-spacer" />
          {session && session.state === "running" ? (
            <button
              className="session-send-button session-stop-button"
              type="button"
              title="Stop session"
              aria-label="Stop session"
              onClick={() => void onTerminateSession(session.id)}
            >
              <Square size={16} />
            </button>
          ) : (() => {
            const sendDisabled = !canSend || isSending || !input.trim();
            const sendTitle = isQueueing
              ? "Queue follow-up — sent when the current turn finishes"
              : "Send follow-up";
            const happy = happyFlashUntilMs > Date.now();
            // Derive the mascot mood from real session state. Order matters:
            // happy (post-completion flash) overrides idle; thinking and
            // working only apply while a turn is in flight; sad is the
            // disabled fallback.
            const mood: "idle" | "thinking" | "happy" | "sad" | "working" = happy
              ? "happy"
              : sendDisabled
                ? "sad"
                : isThinking
                  ? "thinking"
                  : session?.state === "running"
                    ? "working"
                    : "idle";
            const bobbing = justSentAt > 0 && Date.now() - justSentAt < MASCOT_BOB_MS;
            return (
              <Mascot
                size={36}
                mood={mood}
                type="submit"
                disabled={sendDisabled}
                title={sendTitle}
                label={sendTitle}
                buttonClassName={`session-send-mascot${bobbing ? " session-send-mascot--bob" : ""}`}
              />
            );
          })()}
        </div>
      </form>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
