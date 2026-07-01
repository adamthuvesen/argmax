import {
  ArrowDown,
  GitBranch,
  X
} from "lucide-react";
import {
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
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useSmartFollowScroll } from "../hooks/useSmartFollowScroll.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { modelPickerSelectionFromSession, thinkingModelSlug, type ModelPickerSelection } from "../lib/models.js";
import { repoNameFromPath } from "../lib/projects.js";
import { buildTerminalTranscript } from "../lib/rawProvider.js";
import { DEFAULT_THINKING_STYLE, type ThinkingStyle } from "../lib/thinkingStyle.js";
import {
  readStoredAgentMode,
  sessionAgentModeKey,
  writeStoredAgentMode
} from "../lib/agentMode.js";
import {
  buildConversationEvents,
  buildSessionToolCalls,
  hasRenderableSessionContent,
  lastSignificantSessionEvent
} from "../lib/sessionConversationModel.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { CostPanel } from "./CostPanel.js";
import { computeTurnModelHeaderMap } from "../lib/turnHeaderModel.js";
import { foldConversationItems, foldRenderItems, type RenderItem } from "../lib/foldConversation.js";
import { parseQuestionsFromToolInput } from "../lib/questions.js";
import { hasOutstandingCardAsk as sessionHasOutstandingCardAsk } from "../lib/turnInteractiveCards.js";
import { foldTurnToolItems } from "../lib/turnToolItems.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { SessionComposer } from "./SessionComposer.js";
import { SessionActionsMenu } from "./SessionActionsMenu.js";
import { ThinkingTranscript } from "./ThinkingTranscript.js";
import { ThinkingVerbs } from "./ThinkingVerbs.js";
import { parseUserMessageAttachments } from "./sessionConversationHelpers.js";
import {
  SessionConversationTurn,
  SessionConversationUserMessage
} from "./SessionConversationTurn.js";

// How long a mid-turn pause (the agent finished a chunk and is silently working
// on the next step) must persist before the Thinking indicator reappears. Short
// enough to cover a real "few seconds" gap, long enough that the brief window
// between the final answer completing and the runtime flipping out of `running`
// — and quick tool-to-tool hand-offs — don't flash a spinner under finished
// content.
const THINKING_PAUSE_DELAY_MS = 600;
const TOOL_THINKING_PAUSE_DELAY_MS = 1500;

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  events,
  fastModeEnabled = false,
  isLogOpen,
  onClose,
  onFastModeEnabledChange,
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
  fastModeEnabled?: boolean;
  isLogOpen: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  /** When provided, a close (×) button is rendered in the header — used by the multi-pane grid. */
  onClose?: () => void;
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
  const [status, setStatus] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelPickerSelection>(() => modelPickerSelectionFromSession(session));
  const [agentMode, setAgentMode] = useState<AgentMode>(() =>
    session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "auto") : "auto"
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldRefocusInput = useRef(false);
  const sessionId = session?.id ?? null;
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(() => buildConversationEvents(events), [events]);
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
  const lastSignificantEvent = useMemo(() => lastSignificantSessionEvent(events), [events]);
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
  // The pre-answer beat shows immediately. Pauses after completed assistant
  // text or a completed tool are debounced: quick end-of-turn races and
  // tool-to-tool hand-offs stay quiet, but a longer silent gap gets Thinking so
  // the live turn does not look frozen under already-completed rows.
  const isPreAnswerBeat =
    lastSignificantEvent === undefined || lastSignificantEvent.type === "user.message";
  const inDebouncedPause =
    agentWorkingSilently &&
    (lastSignificantEvent?.type === "message.completed" ||
      lastSignificantEvent?.type === "command.completed");
  const pauseDelayMs =
    lastSignificantEvent?.type === "command.completed"
      ? TOOL_THINKING_PAUSE_DELAY_MS
      : THINKING_PAUSE_DELAY_MS;
  const [pauseSettled, setPauseSettled] = useState(false);
  useEffect(() => {
    if (!inDebouncedPause) {
      setPauseSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setPauseSettled(true), pauseDelayMs);
    return () => window.clearTimeout(timer);
  }, [inDebouncedPause, pauseDelayMs]);
  const isThinking = agentWorkingSilently && (isPreAnswerBeat || pauseSettled);

  const {
    conversationListRef,
    metaCardsRef,
    showScrollToBottom,
    newBelowCount,
    scrollToBottom: scrollConversationToBottom,
    handleScroll: handleConversationScroll
  } = useSmartFollowScroll(sessionId, conversationItems, isThinking);
  const repositoryName = project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";

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
      <div className="section-heading" data-window-drag>
        <div className="session-title">
          <GitBranch size={13} aria-hidden="true" className="session-title-icon" />
          <h2>{repositoryName}</h2>
        </div>
        <div className="conversation-header-actions">
          <SessionActionsMenu
            isLogOpen={isLogOpen}
            onBrowseFiles={review.openPanelInFilesMode}
            onCreateCheckpoint={onCreateCheckpoint}
            onOpenCommitDialog={onOpenCommitDialog}
            onToggleLog={onToggleLog}
            session={session}
            setStatus={setStatus}
            workspace={workspace}
          />
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
            aria-label={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
            title={newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest"}
            onClick={scrollConversationToBottom}
          >
            <ArrowDown size={19} strokeWidth={2.2} aria-hidden="true" />
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
      <SessionComposer
        agentMode={agentMode}
        canSend={canSend}
        events={events}
        fastModeEnabled={fastModeEnabled}
        inputRef={inputRef}
        isQueueing={isQueueing}
        isThinking={isThinking}
        onFastModeEnabledChange={onFastModeEnabledChange}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onSendSessionInput={onSendSessionInput}
        onTerminateSession={onTerminateSession}
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
