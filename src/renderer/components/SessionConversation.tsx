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
import { MASCOT_BOB_MS, useMascotFlash } from "../hooks/useMascotFlash.js";
import { useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { modelSelectionFromSession, thinkingModelSlug } from "../lib/models.js";
import { repoNameFromPath } from "../lib/projects.js";
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
import { CostPanel } from "./CostPanel.js";
import { computeTurnModelHeaderMap } from "../lib/turnHeaderModel.js";
import { foldConversationItems, foldRenderItems, type RenderItem } from "../lib/foldConversation.js";
import { parseQuestionsFromToolInput } from "../lib/questions.js";
import { hasOutstandingCardAsk as sessionHasOutstandingCardAsk } from "../lib/turnInteractiveCards.js";
import { foldTurnToolItems } from "../lib/turnToolItems.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { FilePopover } from "./FilePopover.js";
import { Mascot } from "./Mascot.js";
import { ModelSelector } from "./ModelSelector.js";
import { SkillPopover } from "./SkillPopover.js";
import { ThinkingTranscript } from "./ThinkingTranscript.js";
import { ThinkingVerbs } from "./ThinkingVerbs.js";
import {
  isPayloadTruncationMarker,
  isSubAgentProseEcho,
  parseUserMessageAttachments
} from "./sessionConversationHelpers.js";
import {
  SessionConversationTurn,
  SessionConversationUserMessage
} from "./SessionConversationTurn.js";

const PROMPT_MAX_HEIGHT_PX = 140;

// How long a mid-turn pause (the agent finished a chunk and is silently working
// on the next step) must persist before the Thinking indicator reappears. Short
// enough to cover a real "few seconds" gap, long enough that the brief window
// between the final answer completing and the runtime flipping out of `running`
// — and quick tool-to-tool hand-offs — don't flash a spinner under finished
// content.
const THINKING_PAUSE_DELAY_MS = 600;

function isConversationEventType(type: string): boolean {
  return type === "user.message" || type === "message.delta" || type === "message.completed" || type === "error";
}

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
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
  defaultThinkingExpanded?: boolean;
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
            isConversationEventType(event.type) &&
            event.message !== "turn.completed"
        )
        .reverse();
      // Providers stream message.delta fragments and then a final message.completed
      // with the accumulated text. Once a turn has a completed event, the deltas
      // are stale duplicates — keep them only while streaming (before completion).
      let hasCompletedBeforeNextUser = false;
      const visible: TimelineEvent[] = [];
      for (let index = ascending.length - 1; index >= 0; index -= 1) {
        const event = ascending[index];
        if (!event) continue;
        if (event.type === "user.message") {
          hasCompletedBeforeNextUser = false;
          visible.push(event);
          continue;
        }
        if (event.type === "message.completed") {
          hasCompletedBeforeNextUser = true;
          visible.push(event);
          continue;
        }
        if (event.type !== "message.delta") {
          visible.push(event);
          continue;
        }
        // Extended-thinking deltas (payload.thinking === true) are the only
        // record of Claude's reasoning step — message.completed carries the
        // answer text only. Keep them past completion so the persistent Thought
        // block survives the turn, matching pruneSupersededDeltas in snapshot.ts.
        if (event.payload?.["thinking"] === true || !hasCompletedBeforeNextUser) {
          visible.push(event);
        }
      }
      visible.reverse();
      return visible;
    },
    [events]
  );
  // Hide the raw-stdout fallback as soon as ANY renderable content exists —
  // a streamed message OR a tool call. Otherwise the agent's first beat (often
  // a tool_use before any text) flashes the raw provider JSONL through the
  // gray .chat-bubble.terminal-transcript pre while normalized events catch up.
  // `session.streaming` is the one-shot beacon the runtime fires on the first
  // byte from the child; counting it here suppresses the JSON dump that
  // otherwise leaks the 8 KB system-init payload into the chat while Claude
  // is still in its pre-answer thinking phase.
  const hasRenderableContent =
    conversationEvents.some((event) => event.type !== "user.message") ||
    events.some(
      (event) => event.type === "command.started" || event.type === "session.streaming"
    );
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
        const rawParent = event.payload.parent_tool_use_id;
        const parentToolUseId =
          typeof rawParent === "string" && rawParent.length > 0 ? rawParent : null;
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
          error: completion && isError ? extractToolError(completion.payload) : null,
          parentToolUseId
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events]);

  const conversationItems = useMemo(
    () => foldConversationItems(conversationEvents, toolCalls),
    [conversationEvents, toolCalls]
  );

  const renderItems = useMemo(
    (): RenderItem[] => foldRenderItems(conversationItems, session, foldTurnToolItems),
    [conversationItems, session]
  );
  // Computed once per render-item change rather than inline in the render loop.
  // An inline call rebuilt this Map on every render (every keystroke in the
  // composer included), and a fresh Map prop would defeat the memoized turn.
  const turnShowsModelHeader = useMemo(
    () => computeTurnModelHeaderMap(renderItems, selectedModel.label),
    [renderItems, selectedModel.label]
  );

  // Composer is enabled whenever the session is alive — `running` no longer
  // blocks: typed messages get queued in main and drain when the current turn
  // finishes. `complete` and `cancelled` are also enabled because main's
  // sendInput re-launches the agent when no live handle exists, so the user
  // can keep chatting after a turn ends or they hit Stop. `failed` is enabled
  // for the same reason: a session marked failed (most commonly because its
  // provider process didn't survive an app restart — orphan recovery) has no
  // live handle, so sending input takes the same relaunch-with-resume path and
  // continues the old conversation rather than stranding it.
  const canSend = Boolean(
    session && ["complete", "waiting", "running", "cancelled", "failed"].includes(session.state)
  );
  // Currently running → the next submit goes onto the queue rather than
  // straight to the agent. Used to tweak placeholder and Send tooltip copy.
  const isQueueing = session?.state === "running";
  const lastSignificantEvent = events.find(
    (event) =>
      event.payload.raw !== true &&
      !isPayloadTruncationMarker(event) &&
      !isSubAgentProseEcho(event) &&
      event.message !== "turn.completed" &&
      (event.type === "user.message" ||
        event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.started" ||
        event.type === "command.completed")
  );
  // Show the "Thinking" indicator whenever the turn is running but nothing on
  // screen conveys live progress *right now*. The two things that already say
  // "work is happening" are:
  //   (a) assistant text actively streaming (the latest event is a delta), and
  //   (b) the running spinner on a visible tool row.
  // Note we key on a *streaming* delta, not on any completed message: a
  // finished chunk ("now I'll edit the file") followed by a few seconds of
  // silent work used to suppress Thinking entirely, leaving the turn looking
  // idle. The `ExitPlanMode` / `AskUserQuestion` tools are *hidden* (rendered
  // as cards), so a running instance of either gives no on-screen indicator —
  // treat them as "no visible tool running" and let Thinking show.
  const isStreamingText = lastSignificantEvent?.type === "message.delta";
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
  // The turn is live and nothing visible is progressing this instant. True both
  // for the pre-answer beat (nothing emitted yet) and for mid-turn pauses (the
  // agent finished a chunk and is silently working on the next step). We used to
  // suppress the Codex `session.streaming` first-byte beacon here, but that
  // blanked the whole initial wait — Codex reasons for seconds before any item
  // lands, and the beacon (raw bytes) isn't user-visible progress. The beacon
  // still suppresses the raw-stdout transcript via `hasRenderableContent`.
  const agentWorkingSilently =
    session?.state === "running" &&
    !anyVisibleToolRunning &&
    !hasOutstandingCardAsk &&
    !isStreamingText;
  // The pre-answer beat shows immediately. A pause *after* completed content is
  // debounced (THINKING_PAUSE_DELAY_MS): the brief gap between the final answer
  // completing and the runtime flipping out of `running`, plus quick
  // tool-to-tool hand-offs, would otherwise flash a spinner under finished
  // content. Genuine multi-second pauses outlast the delay and surface Thinking.
  const isPreAnswerBeat =
    lastSignificantEvent === undefined || lastSignificantEvent.type === "user.message";
  const inDebouncedPause = agentWorkingSilently && !isPreAnswerBeat;
  const [pauseSettled, setPauseSettled] = useState(false);
  useEffect(() => {
    if (!inDebouncedPause) {
      setPauseSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setPauseSettled(true), THINKING_PAUSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inDebouncedPause]);
  const isThinking = agentWorkingSilently && (isPreAnswerBeat || pauseSettled);

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
      <div className="section-heading" data-window-drag>
        <div className="session-title">
          <GitBranch size={13} aria-hidden="true" className="session-title-icon" />
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
                        onClick={() => {
                          closeActions();
                          onToggleLog();
                        }}
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
          renderItems.map((item, index) => {
            if (item.kind === "user-message") {
              return (
                <SessionConversationUserMessage
                  key={item.event.id}
                  event={item.event}
                  attachments={parseUserMessageAttachments(item)}
                />
              );
            }
            return (
              <SessionConversationTurn
                key={item.id}
                item={item}
                priorItem={index > 0 ? renderItems[index - 1] ?? null : null}
                isLatestTurn={index === renderItems.length - 1}
                showModelHeader={turnShowsModelHeader.get(index) ?? false}
                session={session}
                selectedModel={selectedModel}
                workspace={workspace}
                onOpenFile={onOpenFile}
                onTerminateSession={onTerminateSession}
                onSendSessionInput={onSendSessionInput}
                inputRef={inputRef}
                shouldRefocusInput={shouldRefocusInput}
                setStatus={setStatus}
                setAgentMode={setAgentMode}
                defaultToolCallsExpanded={defaultToolCallsExpanded}
                defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                defaultThinkingExpanded={defaultThinkingExpanded}
              />
            );
          })
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
        {status ? (
          <p className="composer-status" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </section>
  );
}
