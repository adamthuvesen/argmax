import {
  ArrowDown,
  GitBranch,
  MessageSquarePlus,
  MessagesSquare,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import type {
  AgentMode,
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
import { useRestoreWithoutMotion } from "../hooks/useRestoreWithoutMotion.js";
import { useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { modelPickerSelectionFromSession, type ModelPickerSelection } from "../lib/models.js";
import { orderedOpenFilePaths } from "../lib/openFileContext.js";
import { repoNameFromPath } from "../lib/projects.js";
import { buildTerminalTranscript } from "../lib/rawProvider.js";
import {
  readStoredAgentMode,
  sessionAgentModeKey,
  writeStoredAgentMode
} from "../lib/agentMode.js";
import { summarizeChangedFiles } from "../lib/changedFiles.js";
import {
  buildConversationEvents,
  buildSessionToolCalls,
  hasRenderableSessionContent,
  lastAgentResponseEvent,
  lastSignificantSessionEvent,
  subAgentToolUseIds
} from "../lib/sessionConversationModel.js";
import { assignAgentCodenames } from "../lib/agentNames.js";
import { isCompacting } from "../lib/compaction.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { CompactionNotice } from "./CompactionNotice.js";
import { CostPanel } from "./CostPanel.js";
import { foldConversationItems, foldRenderItems, type RenderItem } from "../lib/foldConversation.js";
import {
  hasOutstandingCardAsk as sessionHasOutstandingCardAsk,
  isAskUserQuestionToolName,
  isExitPlanModeToolName
} from "../lib/turnInteractiveCards.js";
import { foldTurnToolItems } from "../lib/turnToolItems.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import {
  createAnnotation,
  createReviewCommentAnnotation,
  type ComposerAnnotation,
  type ReviewCommentInput
} from "../lib/composerAnnotations.js";
import { buildDetailsSeed, buildSideChatSeed } from "../lib/sideChat.js";
import { SelectionToolbar, type ChatSelection } from "./SelectionToolbar.js";
import { SessionComposer, type ComposerStatus } from "./SessionComposer.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { ThinkingLabel } from "./ThinkingLabel.js";
import { parseUserMessageAttachments } from "./sessionConversationHelpers.js";
import {
  SessionConversationTurn,
  SessionConversationUserMessage
} from "./SessionConversationTurn.js";

const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " "
]);

const THINKING_SHOW_DELAY_MS = 700;
const THINKING_AFTER_ASSISTANT_COMPLETED_DELAY_MS = 1800;
const THINKING_MIN_VISIBLE_MS = 600;

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  events,
  fastModeEnabled = false,
  isLogOpen,
  isTerminalOpen,
  onClose,
  onFastModeEnabledChange,
  onHideWorkspaceCard,
  onNewSession,
  onOpenSideChat,
  onOpenDetails,
  onAttachToChat,
  headingLabel,
  floating = false,
  registerAnnotationSink,
  defaultIde = null,
  detectedIdes = [],
  onOpenInIde,
  onOpenCommitDialog,
  onSendSessionInput,
  onCancelQueuedMessage,
  onSendQueuedMessageNow,
  pendingMessages = [],
  onTerminateSession,
  onRunCheck,
  onToggleLog,
  onToggleTerminal,
  onToggleWorkspaceCard,
  onOpenFile,
  onOpenAgent,
  pendingApprovalCount = 0,
  project,
  rawOutputs,
  review,
  session,
  showCostPanel = true,
  workspaceCardEnabled = true,
  workspace
}: {
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  events: TimelineEvent[];
  fastModeEnabled?: boolean;
  isLogOpen: boolean;
  isTerminalOpen?: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onHideWorkspaceCard?: () => void;
  onToggleTerminal?: () => void;
  onToggleWorkspaceCard?: () => void;
  /** User preference for the workspace card. A docked right-hand panel still
      wins over it. The card is the stand-in for exactly that panel. */
  workspaceCardEnabled?: boolean;
  /** When provided, a close (×) button is rendered in the header — used by the multi-pane grid. */
  onClose?: () => void;
  /** Opens a launcher pane beside this one, for a task in any repository. */
  onNewSession?: () => void;
  /** Launches a repo-less side chat with the given first message. Enables the
      selection toolbar's "Ask in side chat" action when provided. */
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  /** Opens the "More details" explainer popup with the given first message.
      Enables the selection toolbar's "More details" action when provided. */
  onOpenDetails?: (
    seedPrompt: string,
    context?: { attachToChat?: () => void }
  ) => Promise<void>;
  /** Floating popup only: "Add to chat" header button wired back to the
   *  originating composer's annotation lane. */
  onAttachToChat?: () => void;
  /** Header title override — the popup labels itself instead of showing the
      backing scratch workspace's name. */
  headingLabel?: string;
  /** The floating "More details" popup: no window-drag header (it would move
      the whole app window), no session-actions menu (its actions are
      pane-bound), and popup-flavored close labels. */
  floating?: boolean;
  /** Lets the parent pane feed review-panel line comments into this
      conversation's annotation lane. Registered on mount, cleared on unmount. */
  registerAnnotationSink?: (sink: ((input: ReviewCommentInput) => void) | null) => void;
  defaultIde?: IdeId | null;
  detectedIdes?: DetectedIde[];
  /** Opens this pane's workspace in the given IDE (session actions menu). */
  onOpenInIde?: (ide: IdeId) => void;
  onOpenCommitDialog?: () => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  /** Follow-ups composed while the agent was running. Render as cancellable
      chips above the composer; cleared from the parent as the queue drains. */
  pendingMessages?: PendingMessage[];
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow?: (sessionId: string, messageId: string) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onToggleLog: () => void;
  /** Called when the user clicks a file reference inside agent text. When
      provided, the chip routes to the in-app right panel by default, with
      ⌘/Ctrl-click flagged via `preferIde` for the external IDE shortcut. */
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
  pendingApprovalCount?: number;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  showCostPanel?: boolean;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [status, setStatusState] = useState<ComposerStatus | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  // Errors persist until the next action replaces them; info notes auto-clear
  // like a toast. Every set clears the pending timer so a stale info timeout
  // can never wipe an error that landed after it.
  const setStatus = useCallback((next: ComposerStatus | null): void => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusState(next);
    if (next?.kind === "info") {
      statusTimerRef.current = window.setTimeout(() => {
        statusTimerRef.current = null;
        setStatusState(null);
      }, 4000);
    }
  }, []);
  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    };
  }, []);
  const [selectedModel, setSelectedModel] = useState<ModelPickerSelection>(() => modelPickerSelectionFromSession(session));
  const [agentMode, setAgentMode] = useState<AgentMode>(() =>
    session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "auto") : "auto"
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldRefocusInput = useRef(false);
  const sessionId = session?.id ?? null;
  // Excerpts attached from the transcript via the selection toolbar. Ephemeral
  // by design (unlike the localStorage-backed draft text): they quote messages
  // of the open transcript, so they don't outlive the pane or follow a session
  // switch.
  const [pendingAnnotations, setPendingAnnotations] = useState<ComposerAnnotation[]>([]);
  useEffect(() => {
    setPendingAnnotations([]);
  }, [sessionId]);
  const addAnnotation = useCallback(
    (selection: ChatSelection): void => {
      setPendingAnnotations((prev) => [...prev, createAnnotation(selection.text)]);
      inputRef.current?.focus();
    },
    []
  );
  const removeAnnotation = useCallback((id: string): void => {
    setPendingAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);
  // Files open as review-panel tabs ride along with sends while the panel is
  // visible, so the agent knows what the user is looking at.
  const openFilePaths = useMemo(
    () =>
      review.isPanelOpen
        ? orderedOpenFilePaths(review.workspaceFiles.tabs, review.workspaceFiles.activeTabPath)
        : [],
    [review.isPanelOpen, review.workspaceFiles.tabs, review.workspaceFiles.activeTabPath]
  );
  const clearAnnotations = useCallback((): void => {
    setPendingAnnotations([]);
  }, []);
  // Line comments authored in the sibling ReviewPanel arrive through this
  // sink (registered with the pane) and join the same annotation lane.
  useEffect(() => {
    if (!registerAnnotationSink) return undefined;
    registerAnnotationSink((input) => {
      setPendingAnnotations((prev) => [...prev, createReviewCommentAnnotation(input)]);
      inputRef.current?.focus();
    });
    return () => registerAnnotationSink(null);
  }, [registerAnnotationSink]);
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(() => buildConversationEvents(events), [events]);
  const askSideChat = useMemo(() => {
    if (!onOpenSideChat) return undefined;
    return (selection: ChatSelection): void => {
      void onOpenSideChat(buildSideChatSeed(selection.text, conversationEvents)).catch((error) => {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not open a side chat."
        });
      });
    };
  }, [conversationEvents, onOpenSideChat, setStatus]);
  const askDetails = useMemo(() => {
    if (!onOpenDetails) return undefined;
    return (selection: ChatSelection): void => {
      void onOpenDetails(buildDetailsSeed(selection.text, conversationEvents), {
        // The popup hides the seed excerpt; this closure lets its header
        // button attach that excerpt to this composer instead.
        attachToChat: () => addAnnotation(selection)
      }).catch((error) => {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not open the details popup."
        });
      });
    };
  }, [addAnnotation, conversationEvents, onOpenDetails, setStatus]);
  // Hide the raw-stdout fallback as soon as ANY renderable content exists —
  // a streamed message OR a tool call. Otherwise the agent's first beat (often
  // a tool_use before any text) flashes the raw provider JSONL through the
  // gray .chat-bubble.terminal-transcript pre while normalized events catch up.
  // `session.streaming` is the one-shot beacon the runtime fires on the first
  // byte from the child; counting it here suppresses the JSON dump that
  // otherwise leaks the 8 KB system-init payload into the chat while Claude
  // is still in its pre-answer thinking phase.
  const hasRenderableContent = hasRenderableSessionContent(conversationEvents, events);
  const terminalTranscript = useMemo(
    () => (hasRenderableContent ? "" : buildTerminalTranscript(rawOutputs, session?.id ?? null)),
    [rawOutputs, session?.id, hasRenderableContent]
  );

  // Only a running session can hold a genuinely in-flight tool. Passing this
  // lets buildSessionToolCalls retire a tool whose `command.completed` was
  // dropped (e.g. an oversized image tool_result) once the session stops,
  // instead of leaving a tool row spinning forever.
  const sessionRunning = session?.state === "running";
  const toolCalls = useMemo(
    () => buildSessionToolCalls(events, sessionRunning),
    [events, sessionRunning]
  );
  const agentCodenames = useMemo(() => assignAgentCodenames(toolCalls), [toolCalls]);

  const conversationItems = useMemo(
    () => foldConversationItems(conversationEvents, toolCalls),
    [conversationEvents, toolCalls]
  );

  const renderItems = useMemo(
    (): RenderItem[] => foldRenderItems(conversationItems, session, foldTurnToolItems),
    [conversationItems, session]
  );
  // The card is the ambient stand-in for a docked right-hand panel, so an open
  // review or debug-log panel takes its place rather than sitting beside it.
  const showWorkspaceCard = workspaceCardEnabled && !review.isPanelOpen && !isLogOpen;
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  // The width gate lives in CSS (chat-workspace-card.css keeps the card
  // `display: none` until the pane can hold it beside the transcript), so
  // enabling it in a narrow pane changes nothing on screen. Asking the DOM
  // whether the card actually appeared keeps CSS the single source of truth
  // while turning the silent no-op into an explained one.
  const handleToggleWorkspaceCard = useMemo(() => {
    if (!onToggleWorkspaceCard) return undefined;
    return (): void => {
      const enabling = !workspaceCardEnabled;
      onToggleWorkspaceCard();
      if (!enabling || review.isPanelOpen || isLogOpen || !workspace) return;
      requestAnimationFrame(() => {
        const card = conversationScrollRef.current?.querySelector('aside[aria-label="Workspace"]');
        if (card instanceof HTMLElement && getComputedStyle(card).display === "none") {
          setStatus({
            kind: "info",
            message:
              "Workspace card is on, but this pane is too narrow to show it. Widen the pane or pick a narrower chat width in Settings."
          });
        }
      });
    };
  }, [onToggleWorkspaceCard, workspaceCardEnabled, review.isPanelOpen, isLogOpen, workspace, setStatus]);
  const changeSummary = useMemo(() => {
    if (review.filesState !== "ready" || review.files.length === 0) {
      return null;
    }
    const totals = summarizeChangedFiles(review.files);
    return {
      fileCount: review.files.length,
      additions: totals.additions,
      deletions: totals.deletions,
      isOpen: review.isPanelOpen && review.mode === "changes",
      onOpen: review.toggleChangesPanel
    };
  }, [review.files, review.filesState, review.isPanelOpen, review.mode, review.toggleChangesPanel]);
  // Composer is enabled whenever the session is alive. During `running`,
  // typed messages get queued in main and drain when the current turn
  // finishes. `complete` and `cancelled` are also enabled because main's
  // sendInput re-launches the agent when no live handle exists, so the user
  // can keep chatting after a turn ends or they hit Stop. `failed` is enabled
  // for the same reason: a session marked failed (most commonly because its
  // provider process didn't survive an app restart — orphan recovery) has no
  // live handle, so sending input takes the same relaunch-with-resume path and
  // continues the conversation.
  const canSend = Boolean(
    session && ["complete", "waiting", "running", "cancelled", "failed"].includes(session.state)
  );
  // Currently running → the next submit goes onto the queue rather than
  // straight to the agent. Used to tweak placeholder and Send tooltip copy.
  const isQueueing = session?.state === "running";
  // Rows that belong to a launched subagent never render in the parent chat.
  // Letting them drive the parent's progress state made the Thinking label
  // blink on every child heartbeat while the parent was only waiting.
  const childToolUseIds = useMemo(() => subAgentToolUseIds(toolCalls), [toolCalls]);
  const lastSignificantEvent = useMemo(
    () => lastSignificantSessionEvent(events, childToolUseIds),
    [childToolUseIds, events]
  );
  // A send from this pane proves a turn is starting, whether or not the
  // backend has flipped the session to `running` and whether or not the new
  // `user.message` has reached the renderer yet. Without this the chat sat
  // blank for as long as the provider took to emit its first event: every
  // progress cue below is gated on `state === "running"`, and a relaunching
  // or queue-draining follow-up reaches the transcript before that flip does.
  // The baseline is the newest agent-response id at send time, so the local
  // state releases the instant the provider says anything of its own.
  const lastAgentResponseId = useMemo(
    () => lastAgentResponseEvent(events, childToolUseIds)?.id ?? null,
    [childToolUseIds, events]
  );
  const lastAgentResponseIdRef = useRef<string | null>(lastAgentResponseId);
  useEffect(() => {
    lastAgentResponseIdRef.current = lastAgentResponseId;
  }, [lastAgentResponseId]);
  const [turnStartBaseline, setTurnStartBaseline] = useState<{ agentResponseId: string | null } | null>(
    null
  );
  const sendSessionInput = useCallback(
    async (
      targetSessionId: string,
      text: string,
      model: ModelPickerSelection,
      mode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      setTurnStartBaseline({ agentResponseId: lastAgentResponseIdRef.current });
      try {
        await onSendSessionInput(targetSessionId, text, model, mode, attachments);
      } catch (error) {
        setTurnStartBaseline(null);
        throw error;
      }
    },
    [onSendSessionInput]
  );
  const isTurnStarting = turnStartBaseline !== null;
  useEffect(() => {
    if (turnStartBaseline === null) return;
    const agentTookOver = lastAgentResponseId !== turnStartBaseline.agentResponseId;
    // A send that could not start a turn (stop, crash) must not leave the
    // pane pretending the agent is about to speak.
    const turnCannotStart = session?.state === "failed" || session?.state === "cancelled";
    if (agentTookOver || turnCannotStart) {
      setTurnStartBaseline(null);
    }
  }, [lastAgentResponseId, session?.state, turnStartBaseline]);
  // Show the "Thinking" indicator whenever the turn is running but nothing on
  // screen conveys live progress *right now*. The two things that already say
  // "work is happening" are:
  //   (a) assistant text actively streaming (the latest event is a delta), and
  //   (b) the running spinner on a visible tool row.
  // Note we key on a *streaming* delta, not on any completed message: after a
  // finished chunk ("now I'll edit the file"), silent work should still show
  // Thinking. The `ExitPlanMode` / `AskUserQuestion` tools are *hidden* (rendered
  // as cards), so a running instance of either gives no on-screen indicator —
  // treat them as "no visible tool running" and let Thinking show. Subagent
  // child rows fold under their launch row and never render in the parent
  // chat, so they are not visible progress either. While a turn is starting the
  // newest delta belongs to the *previous* turn, so it is history, not live
  // streaming.
  const isStreamingText = !isTurnStarting && lastSignificantEvent?.type === "message.delta";
  const anyVisibleToolRunning = useMemo(
    () =>
      toolCalls.some(
        (tool) =>
          tool.status === "running" &&
          tool.parentToolUseId === null &&
          !isExitPlanModeToolName(tool.name) &&
          !isAskUserQuestionToolName(tool.name)
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
  // agent finished a chunk and is silently working on the next step). The Codex
  // `session.streaming` first-byte beacon is raw bytes, not user-visible
  // progress; it still suppresses the raw-stdout transcript via
  // `hasRenderableContent`.
  const agentWorkingSilently =
    (sessionRunning || isTurnStarting) &&
    !anyVisibleToolRunning &&
    !hasOutstandingCardAsk &&
    !isStreamingText;
  // Compaction is minutes of provider-side silence with its own live marker in
  // the transcript. A second "Thinking" line under it would say less, not more.
  const compacting = useMemo(() => isCompacting(events), [events]);
  // Show the generic indicator for any silent gap in a running turn. It stays
  // hidden while text is actively streaming, a visible tool row is running, or
  // the agent is waiting on an interactive card.
  const isThinking = agentWorkingSilently && !compacting;
  const isInitialThinkingBeat =
    isTurnStarting ||
    lastSignificantEvent === undefined ||
    lastSignificantEvent.type === "user.message";
  const thinkingShowDelayMs =
    lastSignificantEvent?.type === "message.completed"
      ? THINKING_AFTER_ASSISTANT_COMPLETED_DELAY_MS
      : THINKING_SHOW_DELAY_MS;
  const [isThinkingVisible, setIsThinkingVisible] = useState(false);
  const thinkingVisibleSinceRef = useRef(0);
  const thinkingShowTimerRef = useRef<number | null>(null);
  const thinkingHideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setIsThinkingVisible(false);
    setTurnStartBaseline(null);
    thinkingVisibleSinceRef.current = 0;
    if (thinkingShowTimerRef.current !== null) {
      window.clearTimeout(thinkingShowTimerRef.current);
      thinkingShowTimerRef.current = null;
    }
    if (thinkingHideTimerRef.current !== null) {
      window.clearTimeout(thinkingHideTimerRef.current);
      thinkingHideTimerRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (isThinking) {
      if (thinkingHideTimerRef.current !== null) {
        window.clearTimeout(thinkingHideTimerRef.current);
        thinkingHideTimerRef.current = null;
      }
      if (!isThinkingVisible) {
        // A new beat can begin while a mid-turn show delay is still pending —
        // a follow-up landing during the post-answer grace period is exactly
        // that. The new turn owns the indicator, so drop the stale timer and
        // show now instead of serving out the previous gap's delay.
        if (isInitialThinkingBeat) {
          if (thinkingShowTimerRef.current !== null) {
            window.clearTimeout(thinkingShowTimerRef.current);
            thinkingShowTimerRef.current = null;
          }
          thinkingVisibleSinceRef.current = performance.now();
          setIsThinkingVisible(true);
          return;
        }
        if (thinkingShowTimerRef.current !== null) return;
        thinkingShowTimerRef.current = window.setTimeout(() => {
          thinkingShowTimerRef.current = null;
          thinkingVisibleSinceRef.current = performance.now();
          setIsThinkingVisible(true);
        }, thinkingShowDelayMs);
      }
      return;
    }

    if (thinkingShowTimerRef.current !== null) {
      window.clearTimeout(thinkingShowTimerRef.current);
      thinkingShowTimerRef.current = null;
    }
    if (!isThinkingVisible || thinkingHideTimerRef.current !== null) return;

    const elapsed = performance.now() - thinkingVisibleSinceRef.current;
    const hideDelay = Math.max(0, THINKING_MIN_VISIBLE_MS - elapsed);
    if (hideDelay === 0) {
      setIsThinkingVisible(false);
      thinkingVisibleSinceRef.current = 0;
      return;
    }
    thinkingHideTimerRef.current = window.setTimeout(() => {
      thinkingHideTimerRef.current = null;
      thinkingVisibleSinceRef.current = 0;
      setIsThinkingVisible(false);
    }, hideDelay);
  }, [isInitialThinkingBeat, isThinking, isThinkingVisible, thinkingShowDelayMs]);

  useEffect(() => {
    return () => {
      if (thinkingShowTimerRef.current !== null) window.clearTimeout(thinkingShowTimerRef.current);
      if (thinkingHideTimerRef.current !== null) window.clearTimeout(thinkingHideTimerRef.current);
    };
  }, []);

  // Restored turns must not replay their entrance animation on every reopen.
  const restoringTranscript = useRestoreWithoutMotion();
  const {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom: scrollConversationToBottom,
    handleUserScrollIntent: handleConversationScrollIntent,
    handleScroll: handleConversationScroll
  } = useSmartFollowScroll(sessionId, conversationItems, isThinkingVisible, sessionRunning, inputRef);
  const repositoryName =
    headingLabel ?? project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";

  // Depend on session.id rather than the session object: the parent rebuilds
  // SessionSummary references on every dashboard delta, which would otherwise
  // overwrite the user's per-session model pick on every streaming event.
  useEffect(() => {
    setSelectedModel(modelPickerSelectionFromSession(session));
    setAgentMode(session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "auto") : "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.id is the identity gate; `session` mutates per-tick by design
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    writeStoredAgentMode(sessionAgentModeKey(sessionId), agentMode);
  }, [agentMode, sessionId]);

  return (
    <section className="conversation-surface" aria-label="Session conversation">
      <div className="section-heading" data-window-drag={floating ? undefined : true}>
        <div className="session-title">
          {workspace && workspace.kind !== "git" ? (
            <MessagesSquare size={13} aria-hidden="true" className="session-title-icon" />
          ) : (
            <GitBranch size={13} aria-hidden="true" className="session-title-icon" />
          )}
          <h2>{repositoryName}</h2>
        </div>
        <div className="conversation-header-actions">
          {floating && onAttachToChat ? (
            <button
              className="details-attach-chat"
              type="button"
              title="Attach the explained excerpt to the chat composer"
              onClick={onAttachToChat}
            >
              <MessageSquarePlus size={13} aria-hidden="true" />
              <span>Add to chat</span>
            </button>
          ) : null}
          {floating ? null : (
            <SessionActionsMenu
              defaultIde={defaultIde}
              detectedIdes={detectedIdes}
              onOpenInIde={onOpenInIde}
              isLogOpen={isLogOpen}
              isWorkspaceCardEnabled={workspaceCardEnabled}
              onBrowseFiles={review.openPanelInFilesMode}
              onNewSession={onNewSession}
              onOpenCommitDialog={onOpenCommitDialog}
              onToggleLog={onToggleLog}
              onToggleWorkspaceCard={handleToggleWorkspaceCard}
              session={session}
              setStatus={setStatus}
              workspace={workspace}
            />
          )}
          {onClose ? (
            <button
              className="small-icon session-pane-close"
              type="button"
              title={floating ? "Close popup" : "Close pane (⌘W)"}
              aria-label={floating ? "Close popup" : "Close pane"}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>
      {/* Wrapper for the scroll edges: the fade scrims below sit on this
          box, outside the scroller, so the sticky scroll-to-latest button
          inside the list never fades with the content passing under it. */}
      <div className="conversation-scroll" ref={conversationScrollRef} data-restoring={restoringTranscript ? "true" : undefined}>
        {showWorkspaceCard && workspace && workspace.kind === "git" ? (
          <WorkspaceCard
            changeSummary={changeSummary}
            isTerminalOpen={isTerminalOpen ?? false}
            onBrowseFiles={review.openPanelInFilesMode}
            onHide={() => onHideWorkspaceCard?.()}
            onOpenChanges={review.toggleChangesPanel}
            onOpenCommitDialog={onOpenCommitDialog}
            onToggleTerminal={() => onToggleTerminal?.()}
            session={session}
            setStatus={setStatus}
            workspace={workspace}
          />
        ) : null}
        <div
          className="conversation-list"
          ref={conversationListRef}
          onScroll={handleConversationScroll}
          onWheel={handleConversationScrollIntent}
          onTouchMove={handleConversationScrollIntent}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              handleConversationScrollIntent();
            }
          }}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && SCROLL_INTENT_KEYS.has(event.key)) {
              handleConversationScrollIntent();
            }
          }}
        >
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
              if (item.kind === "compaction") {
                return <CompactionNotice key={item.id} notice={item.notice} />;
              }
              return (
                <SessionConversationTurn
                  key={item.id}
                  item={item}
                  priorItem={index > 0 ? renderItems[index - 1] ?? null : null}
                  isLatestTurn={index === renderItems.length - 1}
                  session={session}
                  selectedModel={selectedModel}
                  workspace={workspace}
                  agentCodenames={agentCodenames}
                  onOpenFile={onOpenFile}
                  onOpenAgent={onOpenAgent}
                  onTerminateSession={onTerminateSession}
                  onSendSessionInput={sendSessionInput}
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
              aria-label={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
              title={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
              onClick={scrollConversationToBottom}
            >
              <ArrowDown size={19} strokeWidth={2.2} aria-hidden="true" />
            </button>
          ) : null}
          {/* The Thinking line's slot stays in the layout whether the line is
              in it or not. It is the list's last row, and it leaves at the
              moment the first answer token lands. Unmounting the row there
              would shorten the transcript under a reader pinned to the bottom
              and pull the view up by its height. */}
          <div className="conversation-tail">
            {isThinkingVisible ? <ThinkingLabel /> : null}
          </div>
        </div>
      </div>
      <SelectionToolbar
        containerRef={conversationScrollRef}
        onAddToChat={addAnnotation}
        {...(askSideChat ? { onAskSideChat: askSideChat } : {})}
        {...(askDetails ? { onMoreDetails: askDetails } : {})}
      />
      <div
        className="session-meta-cards"
        data-cost-visible={session && showCostPanel ? "true" : "false"}
      >
        <ChangedFilesCard
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
        <SessionComposer
          agentMode={agentMode}
          canSend={canSend}
          changeSummary={changeSummary}
          fastModeEnabled={fastModeEnabled}
          floating={floating}
          inputRef={inputRef}
          isQueueing={isQueueing}
          onFastModeEnabledChange={onFastModeEnabledChange}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onSendQueuedMessageNow={onSendQueuedMessageNow}
          onSendSessionInput={sendSessionInput}
          onTerminateSession={onTerminateSession}
          pendingAnnotations={pendingAnnotations}
          onRemoveAnnotation={removeAnnotation}
          onClearAnnotations={clearAnnotations}
          openFilePaths={openFilePaths}
          pendingMessages={pendingMessages}
        reviewPanelOpen={review.isPanelOpen}
        selectedModel={selectedModel}
        session={session}
        setAgentMode={setAgentMode}
        setSelectedModel={setSelectedModel}
        setStatus={setStatus}
        shouldRefocusInput={shouldRefocusInput}
        status={status}
        workspace={workspace}
      />
    </section>
  );
}
