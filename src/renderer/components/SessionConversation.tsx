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
import { SCROLL_INTENT_KEYS, useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
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
  eventsAfterLatestClear,
  hasRenderableSessionContent,
  lastAgentResponseEvent,
  lastSignificantSessionEvent,
  latestClearEvent,
  outputsAfterClear,
  subAgentToolUseIds
} from "../lib/sessionConversationModel.js";
import { assignAgentCodenames } from "../lib/agentNames.js";
import { buildSubagentCluster } from "../lib/subagentSummary.js";
import { isCompacting } from "../lib/compaction.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { CompactionNotice } from "./CompactionNotice.js";
import { ProjectMoveNotice } from "./ProjectMoveNotice.js";
import { ProviderSwitchNotice } from "./ProviderSwitchNotice.js";
import { foldConversationItems, foldRenderItems, type RenderItem } from "../lib/foldConversation.js";
import {
  hasOutstandingCardAsk as sessionHasOutstandingCardAsk,
  isAskUserQuestionToolName,
  isExitPlanModeToolName
} from "../lib/turnInteractiveCards.js";
import { liveThoughtOwnsProgress } from "../lib/sessionTurnView.js";
import { isThinkingDelta } from "../lib/turnBoundaries.js";
import { foldTurnToolItems } from "../lib/turnToolItems.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import {
  createAnnotation,
  createReviewCommentAnnotation,
  type ComposerAnnotation,
  type ReviewCommentInput
} from "../lib/composerAnnotations.js";
import { buildDetailsSeed, buildSideChatSeed } from "../lib/sideChat.js";
import { SelectionToolbar, type ChatSelection } from "./SelectionToolbar.js";
import { SessionComposer, type ComposerStatus, type NewSessionSeed } from "./SessionComposer.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { ThinkingLabel } from "./ThinkingLabel.js";
import { recordChatCue, type ChatCueReason } from "../lib/chatCueLog.js";
import { parseUserMessageAttachments } from "./sessionConversationHelpers.js";
import {
  SessionConversationTurn,
  SessionConversationUserMessage
} from "./SessionConversationTurn.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";

// How many transcript items are mounted at once.
//
// Half the sessions in a real database hold ~53 events, but the tail is long:
// the largest holds 3,040 events and 3.3 MB of text, and every one of them was
// a live DOM subtree that React re-reconciled on each streaming delta. Mounting
// a window instead keeps a long session as cheap to render as a short one; the
// rest is one click away and stays in the snapshot either way.
const CONVERSATION_WINDOW = 120;
/// Items revealed per "Show earlier" click.
const CONVERSATION_WINDOW_STEP = 240;

const THINKING_SHOW_DELAY_MS = 700;
/// How long a finished assistant message owns the beat it ended. The text is
/// the progress cue for this window, so the indicator stays down whether or
/// not it was already up when the message landed.
const THINKING_AFTER_ASSISTANT_COMPLETED_DELAY_MS = 1800;
const THINKING_MIN_VISIBLE_MS = 600;

export function SessionConversation({
  checks,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  defaultTurnChangesExpanded,
  events,
  fastModeEnabled = false,
  isLogOpen,
  isTerminalOpen,
  onClose,
  onFastModeEnabledChange,
  onHideWorkspaceCard,
  onNewSession,
  onOpenSideChat,
  onOpenSession,
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
  onClearSession,
  onForkSession,
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
  workspaceCardEnabled = true,
  workspace
}: {
  checks?: CheckRun[];
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  defaultTurnChangesExpanded?: boolean;
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
  onNewSession?: (seed?: NewSessionSeed) => void;
  /** Launches a repo-less side chat with the given first message. Enables the
      selection toolbar's "Ask in side chat" action when provided. */
  onOpenSideChat?: (seedPrompt: string) => Promise<void>;
  /** Focus another chat by session id — the origin bubble's "From <label>"
   *  link, and the actions menu's "Open launching chat". */
  onOpenSession?: (sessionId: string) => void;
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
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onForkSession?: (sessionId: string) => Promise<void>;
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
  const liveEvents = useMemo(() => eventsAfterLatestClear(events), [events]);
  const liveRawOutputs = useMemo(
    () => outputsAfterClear(rawOutputs, latestClearEvent(events)),
    [events, rawOutputs]
  );
  const conversationEvents = useMemo(() => buildConversationEvents(liveEvents), [liveEvents]);
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
  const hasRenderableContent = hasRenderableSessionContent(conversationEvents, liveEvents);
  const terminalTranscript = useMemo(
    () => (hasRenderableContent ? "" : buildTerminalTranscript(liveRawOutputs, session?.id ?? null)),
    [liveRawOutputs, session?.id, hasRenderableContent]
  );

  // Only a running session can hold a genuinely in-flight tool. Passing this
  // lets buildSessionToolCalls retire a tool whose `command.completed` was
  // dropped (e.g. an oversized image tool_result) once the session stops,
  // instead of leaving a tool row spinning forever.
  const sessionRunning = session?.state === "running";
  const toolCalls = useMemo(
    () => buildSessionToolCalls(liveEvents, sessionRunning),
    [liveEvents, sessionRunning]
  );
  const agentCodenames = useMemo(() => assignAgentCodenames(toolCalls), [toolCalls]);
  // The workspace card's Subagents section reads the same tool list the agent
  // tabs do, so its avatars and counts can never disagree with the tabs.
  const subagentCluster = useMemo(() => buildSubagentCluster(toolCalls, agentCodenames), [toolCalls, agentCodenames]);

  const conversationItems = useMemo(
    () => foldConversationItems(conversationEvents, toolCalls),
    [conversationEvents, toolCalls]
  );

  const renderItems = useMemo(
    (): RenderItem[] => foldRenderItems(conversationItems, session, foldTurnToolItems),
    [conversationItems, session]
  );
  const [visibleCount, setVisibleCount] = useState(CONVERSATION_WINDOW);
  // A different session starts from the bottom again.
  useEffect(() => setVisibleCount(CONVERSATION_WINDOW), [sessionId]);
  const windowStart = Math.max(0, renderItems.length - visibleCount);
  const windowedItems = useMemo(
    () => renderItems.slice(windowStart),
    [renderItems, windowStart]
  );
  const lastUserMessageId = useMemo(() => {
    for (let i = renderItems.length - 1; i >= 0; i -= 1) {
      const item = renderItems[i];
      if (item && item.kind === "user-message") return item.event.id;
    }
    return null;
  }, [renderItems]);

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
        if (!(card instanceof HTMLElement)) {
          // A side chat has no worktree, so the card has nothing to summarize
          // and never renders. Silence there is the same lie as silence in a
          // pane too narrow to hold it.
          setStatus({
            kind: "info",
            message: "Workspace card is on. It shows up on chats that have a git worktree."
          });
          return;
        }
        if (getComputedStyle(card).display === "none") {
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
    () => lastSignificantSessionEvent(liveEvents, childToolUseIds),
    [childToolUseIds, liveEvents]
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
    () => lastAgentResponseEvent(liveEvents, childToolUseIds)?.id ?? null,
    [childToolUseIds, liveEvents]
  );
  const lastAgentResponseIdRef = useRef<string | null>(lastAgentResponseId);
  useEffect(() => {
    lastAgentResponseIdRef.current = lastAgentResponseId;
  }, [lastAgentResponseId]);
  // The state the session sat in when the send left this pane. A relaunching
  // follow-up is sent *from* a terminal state, so the terminal check below has
  // to ask whether the session fell into one after the send, not whether it was
  // already in one.
  const sessionStateRef = useRef<SessionSummary["state"] | null>(session?.state ?? null);
  useEffect(() => {
    sessionStateRef.current = session?.state ?? null;
  }, [session?.state]);
  const [turnStartBaseline, setTurnStartBaseline] = useState<{
    agentResponseId: string | null;
    state: SessionSummary["state"] | null;
  } | null>(null);
  const sendSessionInput = useCallback(
    async (
      targetSessionId: string,
      text: string,
      model: ModelPickerSelection,
      mode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      setTurnStartBaseline({
        agentResponseId: lastAgentResponseIdRef.current,
        state: sessionStateRef.current
      });
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
    // pane pretending the agent is about to speak. Only a *new* terminal state
    // says that: sending to a `failed` session — an orphan the app adopted back
    // after a restart — or to a `cancelled` one is the ordinary relaunch path,
    // and reading its pre-send state as a dead turn dropped the cue half a
    // second after the send and left the pane blank until the provider spoke.
    const turnCannotStart =
      (session?.state === "failed" || session?.state === "cancelled") &&
      session.state !== turnStartBaseline.state;
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
  // Reasoning arrives as a `message.delta` too (`thinking: true`), and it is
  // not visible answer text: after an answer it renders as a collapsed Thought,
  // and at the lowest verbosity it is dropped from the turn. Counting it as
  // streaming let a model reason silently for 20 s behind no cue at all.
  const isStreamingText =
    !isTurnStarting &&
    lastSignificantEvent?.type === "message.delta" &&
    !isThinkingDelta(lastSignificantEvent);
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
    () => sessionHasOutstandingCardAsk(liveEvents, toolCalls),
    [liveEvents, toolCalls]
  );
  // The turn is live and nothing visible is progressing this instant. True both
  // for the pre-answer beat (nothing emitted yet) and for mid-turn pauses (the
  // agent finished a chunk and is silently working on the next step). The Codex
  // `session.streaming` first-byte beacon is raw bytes, not user-visible
  // progress; it still suppresses the raw-stdout transcript via
  // `hasRenderableContent`.
  // A pre-answer Thought block is already on screen, expanded and labelled
  // "Thinking", so the generic line would be a second cue for one beat. Once
  // the turn has answer text the block goes quiet and this releases.
  const liveThoughtVisible = useMemo(() => {
    if (isTurnStarting) return false;
    const latest = renderItems[renderItems.length - 1];
    if (latest?.kind !== "turn") return false;
    return liveThoughtOwnsProgress({
      assistantEvents: latest.assistantEvents,
      isLatestTurn: true,
      sessionRunning,
      isPausedOnUserInput: hasOutstandingCardAsk
    });
  }, [hasOutstandingCardAsk, isTurnStarting, renderItems, sessionRunning]);
  const agentWorkingSilently =
    sessionRunning &&
    !anyVisibleToolRunning &&
    !hasOutstandingCardAsk &&
    !liveThoughtVisible &&
    !isStreamingText;
  // Compaction is minutes of provider-side silence with its own live marker in
  // the transcript. A second "Thinking" line under it would say less, not more.
  const compacting = useMemo(() => isCompacting(liveEvents), [liveEvents]);
  // A finished assistant message ends the beat that produced it: the text now
  // on screen is the progress cue, so the indicator comes down and only claims
  // the *next* silent gap, once this window elapses. Suppressing at the source
  // rather than only delaying the first show is what makes it provider-shaped
  // rather than Claude-shaped: Codex and OpenCode deliver an answer as one
  // atomic `message.completed` with no answer deltas at all, so nothing ever
  // arrived afterwards to hide a label already up from the reasoning gap
  // before it, and it sat under the finished answer until the session state
  // flipped — a second or so later, since that flip waits for the provider
  // process to exit. Claude and Cursor stream deltas right up to their
  // completion and so were only ever exposed to the same tail on a turn that
  // ended silently.
  const answerBeatId =
    lastSignificantEvent?.type === "message.completed" ? lastSignificantEvent.id : null;
  // Held as the id whose window has *expired*, not as a "settling" flag: a flag
  // starts false, so the first render after the message lands would still claim
  // the beat for one commit and flash the label before the effect could set it.
  const [settledAnswerId, setSettledAnswerId] = useState<string | null>(null);
  const isAnswerSettling = answerBeatId !== null && settledAnswerId !== answerBeatId;
  useEffect(() => {
    if (answerBeatId === null) return;
    const timer = window.setTimeout(
      () => setSettledAnswerId(answerBeatId),
      THINKING_AFTER_ASSISTANT_COMPLETED_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [answerBeatId]);
  // Show the generic indicator for any silent gap in a running turn. It stays
  // hidden while text is actively streaming, a visible tool row is running, an
  // answer is still settling, or the agent is waiting on an interactive card.
  //
  // The window between a send and the provider's first visible event is a floor,
  // not one more case for those rules to weigh: it shows the cue outright. Every
  // suppressor above exists to stop this line doubling up with another live cue —
  // streaming text, a spinning tool row, a live Thought, an outstanding card — and
  // before the provider has said anything there is by definition none of that on
  // screen to double up with. Consulting them there only created ways for the
  // pane to go silent for the ten to thirty seconds a relaunched provider takes
  // to speak, which is the one stretch that most needs a sign of life.
  const isThinking =
    isTurnStarting || (agentWorkingSilently && !compacting && !isAnswerSettling);
  // Beats that have already served their wait: a turn the user just started,
  // and a settled answer — reaching here with the answer still newest means
  // its window is spent, so re-showing must not queue a second delay behind it.
  const isInitialThinkingBeat =
    isTurnStarting ||
    lastSignificantEvent === undefined ||
    lastSignificantEvent.type === "user.message" ||
    lastSignificantEvent.type === "message.completed";
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
        }, THINKING_SHOW_DELAY_MS);
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
  }, [isInitialThinkingBeat, isThinking, isThinkingVisible]);

  useEffect(() => {
    return () => {
      if (thinkingShowTimerRef.current !== null) window.clearTimeout(thinkingShowTimerRef.current);
      if (thinkingHideTimerRef.current !== null) window.clearTimeout(thinkingHideTimerRef.current);
    };
  }, []);

  // One breadcrumb per change in what the cue is doing, and why. A cue that
  // fails to show leaves a blank pane and no evidence: the derivation that
  // decided it is gone by the time anyone reads the transcript. Reading the
  // reason off the same values the render uses keeps the record honest — this
  // cannot drift from the behaviour it describes without the render changing
  // too. Debug panel → Logs, scope `renderer::chat`.
  const cueReason: ChatCueReason = isThinkingVisible
    ? "shown"
    : anyVisibleToolRunning
      ? "tool-running"
      : hasOutstandingCardAsk
        ? "card-ask"
        : liveThoughtVisible
          ? "live-thought"
          : isStreamingText
            ? "streaming-text"
            : compacting
              ? "compacting"
              : isAnswerSettling
                ? "answer-settling"
                : "show-delay";
  const lastCueRef = useRef<string | null>(null);
  useEffect(() => {
    // Only while a turn is live. An idle session has no cue to explain, and
    // logging its steady state would bury the transitions that matter.
    if (!sessionRunning && !isTurnStarting) {
      lastCueRef.current = null;
      return;
    }
    if (!sessionId) return;
    const key = `${isThinkingVisible ? "shown" : "hidden"}:${cueReason}`;
    if (lastCueRef.current === key) return;
    lastCueRef.current = key;
    recordChatCue({
      sessionId,
      provider: session?.provider ?? null,
      visible: isThinkingVisible,
      reason: cueReason
    });
  }, [cueReason, isThinkingVisible, isTurnStarting, session?.provider, sessionId, sessionRunning]);

  // Restored turns must not replay their entrance animation on every reopen.
  const restoringTranscript = useRestoreWithoutMotion();
  const {
    conversationListRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom: scrollConversationToBottom,
    handleUserScrollIntent: handleConversationScrollIntent,
    handleScroll: handleConversationScroll
  } = useSmartFollowScroll(
    sessionId,
    conversationItems,
    isThinkingVisible,
    inputRef,
    lastUserMessageId
  );
  // Revealing earlier turns grows the list upward. The list is bottom-anchored,
  // so holding the distance from the bottom leaves what the user is reading
  // exactly where it was.
  const showEarlierItems = (): void => {
    const list = conversationListRef.current;
    const anchorFromBottom = list ? list.scrollHeight - list.scrollTop : null;
    setVisibleCount((current) => current + CONVERSATION_WINDOW_STEP);
    if (anchorFromBottom === null) return;
    requestAnimationFrame(() => {
      const node = conversationListRef.current;
      if (node) node.scrollTop = node.scrollHeight - anchorFromBottom;
    });
  };
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
    <section className="conversation-surface" aria-label="Conversation">
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
              onNewSession={onNewSession ? () => onNewSession() : undefined}
              onOpenCommitDialog={onOpenCommitDialog}
              onToggleLog={onToggleLog}
              onToggleWorkspaceCard={handleToggleWorkspaceCard}
              onOpenLaunchingChat={
                session?.launchedBySessionId && onOpenSession
                  ? () => onOpenSession(session.launchedBySessionId as string)
                  : undefined
              }
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
            changesState={review.filesState}
            isTerminalOpen={isTerminalOpen ?? false}
            onBrowseFiles={review.openPanelInFilesMode}
            onHide={() => onHideWorkspaceCard?.()}
            onOpenChanges={review.toggleChangesPanel}
            onOpenCommitDialog={onOpenCommitDialog}
            onToggleTerminal={() => onToggleTerminal?.()}
            session={session}
            setStatus={setStatus}
            subagents={subagentCluster}
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
          onPointerMove={(event) => {
            if (event.buttons !== 0) {
              handleConversationScrollIntent();
            }
          }}
          onKeyDown={(event) => {
            // Unlike pointerdown, a scroll key is intent wherever focus sits:
            // the browser scrolls this list for any descendant control.
            if (SCROLL_INTENT_KEYS.has(event.key)) {
              handleConversationScrollIntent();
            }
          }}
        >
          {windowStart > 0 ? (
            <button type="button" className="conversation-show-earlier" onClick={showEarlierItems}>
              Show earlier messages ({windowStart} hidden)
            </button>
          ) : null}
          {renderItems.length > 0 ? (
            windowedItems.map((item, windowIndex) => {
              const index = windowStart + windowIndex;
              if (item.kind === "user-message") {
                return (
                  <SessionConversationUserMessage
                    key={item.event.id}
                    event={item.event}
                    attachments={parseUserMessageAttachments(item)}
                    isTurnAnchor={item.event.id === lastUserMessageId}
                    onOpenSession={onOpenSession}
                  />
                );
              }
              if (item.kind === "compaction") {
                return <CompactionNotice key={item.id} notice={item.notice} />;
              }
              if (item.kind === "project-move") {
                return <ProjectMoveNotice key={item.id} notice={item.notice} />;
              }
              if (item.kind === "provider-switch") {
                return <ProviderSwitchNotice key={item.id} notice={item.notice} />;
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
                  onForkSession={onForkSession}
                  onSendSessionInput={sendSessionInput}
                  inputRef={inputRef}
                  shouldRefocusInput={shouldRefocusInput}
                  setStatus={setStatus}
                  setAgentMode={setAgentMode}
                  defaultToolCallsDisplay={defaultToolCallsDisplay}
                  defaultToolCallGroupsExpanded={defaultToolCallGroupsExpanded}
                  defaultThinkingExpanded={defaultThinkingExpanded}
                  defaultTurnChangesExpanded={defaultTurnChangesExpanded}
                  onOpenDiff={review.openFile}
                  onOpenReview={review.openChangesPanel}
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
              in it or not. It sits after the transcript, and it leaves at the
              moment the first answer token lands. Unmounting the row there
              would shorten the transcript under a reader pinned to the bottom
              and pull the view up by its height. */}
          <div className="conversation-tail">
            {isThinkingVisible ? <ThinkingLabel phaseKey={workspace?.id ?? session?.id} /> : null}
          </div>
          <div className="conversation-turn-spacer" data-conversation-spacer="" aria-hidden="true" />
        </div>
      </div>
      <SelectionToolbar
        containerRef={conversationScrollRef}
        onAddToChat={addAnnotation}
        {...(askSideChat ? { onAskSideChat: askSideChat } : {})}
        {...(askDetails ? { onMoreDetails: askDetails } : {})}
      />
      <div className="session-meta-cards">
        <ChangedFilesCard
          workspaceId={workspace?.id}
          checkCommands={project?.settings.checkCommands ?? []}
          checks={checks ?? []}
          onRunCheck={onRunCheck}
        />
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
                handleConversationScrollIntent();
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
          onStartNewSession={onNewSession}
          onTerminateSession={onTerminateSession}
          onClearSession={onClearSession}
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
