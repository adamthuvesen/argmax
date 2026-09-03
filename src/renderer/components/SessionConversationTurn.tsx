import { Fragment, memo, useMemo, useState, type JSX, type MutableRefObject, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { FORK_CAPABLE_PROVIDERS } from "../../shared/providerModels.js";
import { splitLinkSegments } from "../lib/messageLinks.js";
import { leadingSkillInvocation, splitSkillTokens } from "../lib/slashHighlight.js";
import { ImageLightbox } from "./ImageLightbox.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { parsePlan } from "../lib/parsePlan.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { isSupportedImageMime } from "../lib/composerAttachments.js";
import {
  assistantGroupHasVisibleChat,
  buildTurnRenderState,
  liveThoughtOwnsProgress,
  preToolNarrationGroupIds
} from "../lib/sessionTurnView.js";
import { foldToolRunsToSummaries } from "../lib/turnChildren.js";
import { isAgentToolName, type ToolCall, type TurnToolItem } from "../lib/toolCalls.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";
import { codenameForTool } from "../lib/agentNames.js";
import { latestToolCreatedAt, visibleTurnToolItem } from "../lib/turnToolItems.js";
import { collectTurnFileChanges } from "../lib/turnFileChanges.js";
import { sessionAgentModeKey, writeStoredAgentMode } from "../lib/agentMode.js";
import { thoughtDurationMs } from "../formatElapsed.js";
import type { AgentMode } from "../../shared/types.js";
import { AgentLaunchList } from "./AgentLaunchList.js";
import { MultitaskRow } from "./MultitaskRow.js";
import { ActivitySummaryLine } from "./ActivitySummaryLine.js";
import { ChatBubble } from "./ChatBubble.js";
import { LogBlock } from "./LogBlock.js";
import { PlanCard } from "./PlanCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { ThoughtBlock } from "./ThoughtBlock.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { TurnChangesCard } from "./TurnChangesCard.js";
import { TurnBlock, type TurnBodyChild } from "./TurnBlock.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { WebLink } from "./WebLink.js";
import {
  sendAfterTerminate,
  type SessionConversationSendInput,
  type UserMessageAttachment
} from "./sessionConversationHelpers.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import type { ComposerStatus } from "./SessionComposer.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";

type TurnRenderItem = Extract<RenderItem, { kind: "turn" }>;

function SessionConversationTurnInner({
  item,
  priorItem,
  isLatestTurn,
  session,
  selectedModel,
  workspace,
  agentCodenames,
  onOpenFile,
  onOpenAgent,
  onOpenDiff,
  onOpenMultitask,
  onOpenReview,
  onTerminateSession,
  onForkSession,
  onSendSessionInput,
  inputRef,
  shouldRefocusInput,
  setStatus,
  setAgentMode,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded,
  defaultTurnChangesExpanded,
  multitaskStates
}: {
  item: TurnRenderItem;
  priorItem: RenderItem | null;
  isLatestTurn: boolean;
  session: SessionSummary | null;
  selectedModel: ModelPickerSelection;
  workspace: WorkspaceSummary | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
  /** Open one file's diff in the review panel's Changes view. */
  onOpenDiff?: (path: string) => void;
  /** Open a multitask's chat as a dock tab, beside this session's subagents. */
  onOpenMultitask?: (sessionId: string) => void;
  /** Open the review panel on the workspace's changes, from the top. */
  onOpenReview?: () => void;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onForkSession?: (sessionId: string) => Promise<void>;
  onSendSessionInput: SessionConversationSendInput;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  shouldRefocusInput: MutableRefObject<boolean>;
  setStatus: (status: ComposerStatus | null) => void;
  setAgentMode: (mode: AgentMode) => void;
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
  defaultTurnChangesExpanded?: boolean;
  /** Each multitask's own chat state, which outranks its timeline rows. */
  multitaskStates?: Map<string, string>;
}): JSX.Element {
  const sessionIsLive = session?.state === "running";
  const isStreamingTurn = isLatestTurn && sessionIsLive;
  // Memoized because the state it returns is the input to everything below:
  // `hiddenToolIds` is a fresh Set per call, and it is the only dep of
  // `visibleToolItems`, which is the only dep of `turnChanges`. Re-deriving it
  // in the render body missed both of those memos on every streaming delta, so
  // each mounted turn re-ran `coalesceAssistantGroups`, `parsePlan`, and a diff
  // parse per Edit tool for every chunk that arrived anywhere in the session.
  const turnView = useMemo(
    () =>
      buildTurnRenderState({
        assistantEvents: item.assistantEvents,
        toolItems: item.toolItems,
        priorItem,
        assistantTimestamps: item.assistantTimestamps,
        isStreamingTurn
      }),
    [item.assistantEvents, item.toolItems, priorItem, item.assistantTimestamps, isStreamingTurn]
  );
  const {
    visibleAssistantGroups,
    turnAgentMode,
    exitPlanTool,
    askUserQuestionTool,
    hiddenToolIds,
    turnStartedAtMs,
    isPausedOnUserInput
  } = turnView;
  // A Thought block is "live" (shown expanded, labelled "Thinking", in place of
  // the generic indicator) while this turn is actively working and hasn't
  // produced its answer yet. Once any answer text lands the label settles, but
  // the body stays open (`holdOpen`) for as long as this is the newest turn:
  // folding it right then would drop the whole reasoning out of a transcript
  // pinned to the bottom at the exact moment the answer starts arriving. An
  // explicit fold from the turn chip still wins, and the turn falls back to the
  // saved expanded-by-default setting for quiet, persistent "Thought" history
  // as soon as a newer turn starts.
  const thinkingLive = liveThoughtOwnsProgress({
    assistantEvents: item.assistantEvents,
    isLatestTurn,
    sessionRunning: sessionIsLive,
    isPausedOnUserInput
  });
  // Tool groups expand by default for the current turn (you're watching it
  // work, and it stays open through completion so nothing collapses out from
  // under the answer) and collapse to headers for older turns. The turn chip
  // toggles this for the whole turn; collapsing folds the tool groups to their
  // headers AND the Thought block, so one control governs the turn's reasoning
  // and its tools. A per-row chevron still overrides an individual group or the
  // Thought block. "Tool call groups" still wins over "Tool calls in chat" when
  // it is set, so groups can open while the tool rows stay collapsed.
  // Single-line (Minimal) never expands groups: tool runs render as one
  // self-updating line while the turn is live, then the finished turn hides
  // those working rows behind the chip so only the answer remains.
  const minimalActivity = defaultToolCallsDisplay === "single-line";
  const toolsExpandedDefault =
    isLatestTurn && !minimalActivity
      ? (defaultToolCallGroupsExpanded ?? defaultToolCallsDisplay === "expanded")
      : false;
  const [toolsExpandOverride, setToolsExpandOverride] = useState<boolean | null>(null);
  const toolsExpanded = toolsExpandOverride ?? toolsExpandedDefault;
  const reportSendError = (message: string): void => setStatus({ kind: "error", message });
  const handlePlanAccept = (): Promise<boolean> => {
    if (!session) return Promise.resolve(false);
    setAgentMode("auto");
    writeStoredAgentMode(sessionAgentModeKey(session.id), "auto");
    shouldRefocusInput.current = true;
    const sessionId = session.id;
    return sendAfterTerminate(
      sessionId,
      session.state === "running",
      onTerminateSession,
      () => onSendSessionInput(sessionId, "Proceed with the plan above.", selectedModel, "auto"),
      reportSendError
    );
  };
  const handlePlanReject = (): void => {
    inputRef.current?.focus();
  };
  const handleQuestionAnswer = (answerMarkdown: string): Promise<boolean> => {
    if (!session) return Promise.resolve(false);
    shouldRefocusInput.current = true;
    const sessionId = session.id;
    const nextAgentMode = turnAgentMode === "plan" ? "plan" : "auto";
    return sendAfterTerminate(
      sessionId,
      session.state === "running",
      onTerminateSession,
      () => onSendSessionInput(sessionId, answerMarkdown, selectedModel, nextAgentMode),
      reportSendError
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
  // `createdAt` anchors the turn-start header timestamp; `sortAt` orders the
  // body. Assistant groups order by their LAST activity (see AssistantGroup.
  // lastActivityAt) so a streamed answer settles below the tools it follows
  // instead of floating above them.
  type AnnotatedChild = TurnBodyChild & {
    createdAt: string;
    sortAt: string;
    agentTools?: ToolCall[];
    // Flat tool list this child contributes to a single-line-mode run.
    runTools?: ToolCall[];
  };
  const lastToolCreatedAt = latestToolCreatedAt(item.toolItems);
  // Finished Minimal keeps the answer: assistant text after the last tool.
  // Claude, Codex, Grok, and OpenCode write progress as `message.completed`
  // before each tool. Expanding the chip restores the narration with the
  // tools. Live turns keep it so the user can watch the agent talk while tools
  // run.
  // This turn's own liveness, not the session's: keying off `sessionIsLive`
  // alone re-expanded every finished turn the moment a new turn started.
  const turnIsLive = isLatestTurn && sessionIsLive;
  const hiddenNarrationIds = preToolNarrationGroupIds(
    visibleAssistantGroups,
    minimalActivity && !turnIsLive && !toolsExpanded ? lastToolCreatedAt : null
  );
  const assistantChildren: AnnotatedChild[] = visibleAssistantGroups
    .map((group): AnnotatedChild | null => {
      // Single-line mode folds completed Thought blocks away entirely — only
      // the live "Thinking" indicator (governed by thinkingLive) survives.
      if (minimalActivity && group.thinking && !thinkingLive) return null;
      if (hiddenNarrationIds.has(group.id)) return null;
      if (group.thinking) {
        const node = (
          <ThoughtBlock
            key={group.id}
            defaultExpanded={toolsExpandOverride ?? defaultThinkingExpanded}
            live={thinkingLive}
            holdOpen={isLatestTurn && toolsExpandOverride !== false}
            durationMs={thoughtDurationMs(group.createdAt, group.lastActivityAt)}
          >
            {/* `streaming` while the thought is live is what splits the
                committed prefix off the tail. Rendering a growing reasoning
                buffer as one non-streaming block re-parsed the whole thing per
                delta, so a long thought cost O(n²) before it ever collapsed.
                Unpaced: reasoning arrives in bursts the typewriter cadence
                would trail by seconds, then snap when the thought ends. */}
            <StreamingMarkdown
              text={group.text}
              streaming={thinkingLive}
              paced={false}
              workspace={workspace}
              onOpenFile={onOpenFile}
            />
          </ThoughtBlock>
        );
        return { kind: "assistant", id: group.id, node, createdAt: group.createdAt, sortAt: group.lastActivityAt };
      }
      if (group.error) {
        if (!assistantGroupHasVisibleChat(group)) return null;
        return {
          kind: "assistant",
          id: group.id,
          node: <LogBlock key={group.id} text={group.text} tone="error" />,
          createdAt: group.createdAt,
          sortAt: group.lastActivityAt
        };
      }
      if (!assistantGroupHasVisibleChat(group)) return null;
      const planNode = tryRenderPlan(group);
      if (planNode) {
        return { kind: "assistant", id: group.id, node: planNode, createdAt: group.createdAt, sortAt: group.lastActivityAt };
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
            revealKey={session ? `${session.id}:${group.createdAt}:${group.id}` : null}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        </ChatBubble>
      );
      return { kind: "assistant", id: group.id, node, createdAt: group.createdAt, sortAt: group.lastActivityAt };
    })
    .filter((child): child is AnnotatedChild => child !== null);
  if (exitPlanCard && exitPlanTool) {
    assistantChildren.push({
      kind: "assistant",
      id: `plan-${exitPlanTool.id}`,
      node: exitPlanCard,
      createdAt: exitPlanTool.createdAt,
      sortAt: exitPlanTool.createdAt
    });
  }
  if (questionCard && askUserQuestionTool) {
    assistantChildren.push({
      kind: "assistant",
      id: `question-${askUserQuestionTool.id}`,
      node: questionCard,
      createdAt: askUserQuestionTool.createdAt,
      sortAt: askUserQuestionTool.createdAt
    });
  }
  const visibleToolItems = useMemo(
    () =>
      item.toolItems
        .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
        .filter((tItem): tItem is TurnToolItem => tItem !== null),
    [item.toolItems, hiddenToolIds]
  );
  const isTurnLiveTicking = isLatestTurn && sessionIsLive && !isPausedOnUserInput;
  const toolChildren: AnnotatedChild[] = visibleToolItems
    .map((tItem) => {
      if (tItem.kind === "tool") {
        if (isAgentToolName(tItem.tool.name)) {
          return {
            kind: "tool" as const,
            id: tItem.tool.id,
            createdAt: tItem.tool.createdAt,
            sortAt: tItem.tool.createdAt,
            agentTools: [tItem.tool],
            node: null as unknown as JSX.Element
          };
        }
        return {
          kind: "tool" as const,
          id: tItem.tool.id,
          createdAt: tItem.tool.createdAt,
          sortAt: tItem.tool.createdAt,
          runTools: [tItem.tool, ...(tItem.children ?? [])],
          node: (
            <ToolCallRow
              tool={tItem.tool}
              childTools={tItem.children}
              defaultExpanded={toolsExpanded}
              workspaceCwd={workspace?.path ?? null}
              agentCodename={codenameForTool(tItem.tool, agentCodenames)}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )
        };
      }
      const firstCreatedAt = tItem.group.tools[0]?.createdAt ?? "";
      return {
        kind: "tool" as const,
        id: tItem.group.id,
        createdAt: firstCreatedAt,
        sortAt: firstCreatedAt,
        runTools: tItem.group.tools,
        node: (
          <ToolCallGroupBubble
            group={tItem.group}
            defaultExpanded={toolsExpanded}
            workspaceCwd={workspace?.path ?? null}
            agentCodenames={agentCodenames}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        )
      };
    });
  // A multitask sits among the turn's tool rows, at the moment it was
  // dispatched — the same place, and the same shape, as a subagent launch.
  const multitaskChildren: AnnotatedChild[] = item.multitasks.map((notice) => {
    const childId = notice.childSessionId;
    // Only a child still in the snapshot can be opened. One that has aged out
    // of it renders as plain text rather than a button that goes nowhere.
    const opens = childId !== null && multitaskStates?.has(childId) === true;
    return {
      kind: "tool" as const,
      id: `multitask-${childId ?? notice.createdAt}`,
      createdAt: notice.createdAt,
      sortAt: notice.createdAt,
      node: (
        <MultitaskRow
          notice={notice}
          liveState={childId ? (multitaskStates?.get(childId) ?? null) : null}
          {...(opens && onOpenMultitask ? { onOpen: onOpenMultitask } : {})}
          onStop={(sessionId) => void onTerminateSession(sessionId)}
        />
      )
    };
  });
  const sortedChildren = [...assistantChildren, ...toolChildren, ...multitaskChildren]
    .sort((a, b) => {
      const cmp = a.sortAt.localeCompare(b.sortAt);
      if (cmp !== 0) return cmp;
      // Cursor can emit a narration delta and the tool start in the same
      // millisecond. The delta is the thing the user should read first.
      return (a.kind === "assistant" ? -1 : 0) - (b.kind === "assistant" ? -1 : 0);
    });
  const coalescedChildren: AnnotatedChild[] = [];
  for (const child of sortedChildren) {
    const last = coalescedChildren[coalescedChildren.length - 1];
    if (child.agentTools && last?.agentTools) {
      last.agentTools.push(...child.agentTools);
      continue;
    }
    coalescedChildren.push(
      child.agentTools ? { ...child, agentTools: [...child.agentTools] } : child
    );
  }
  // Single-line mode: every consecutive run of tool children between two
  // anchors (assistant text, agent launch, or a card) collapses into ONE line.
  // Agent launches pass through untouched — they are the only extra row
  // allowed between replies.
  const bodySource: AnnotatedChild[] = minimalActivity
    ? foldToolRunsToSummaries(coalescedChildren, (tools) =>
        // A run of one has nothing to summarize: the line and the row it hides
        // are the same sentence with different pluralization ("Fetched 1 URL"
        // over "Fetched URL"). Show the row, which opens straight to detail.
        tools.length === 1 && tools[0] ? (
          <ToolCallRow
            tool={tools[0]}
            workspaceCwd={workspace?.path ?? null}
            agentCodename={codenameForTool(tools[0], agentCodenames)}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        ) : (
          <ActivitySummaryLine
            tools={tools}
            workspaceCwd={workspace?.path ?? null}
            agentCodenames={agentCodenames}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        )
      )
    : coalescedChildren;
  const bodyChildren: TurnBodyChild[] = bodySource.map((child) => {
    if (child.agentTools) {
      const first = child.agentTools[0];
      const id = first ? `agent-list-${first.id}` : child.id;
      return {
        kind: "tool" as const,
        id,
        node: (
          <AgentLaunchList
            key={id}
            tools={child.agentTools}
            defaultExpanded={!minimalActivity && toolsExpanded}
            workspaceCwd={workspace?.path ?? null}
            agentCodenames={agentCodenames}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        )
      };
    }
    return { kind: child.kind, id: child.id, node: child.node };
  });
  const earliestCreatedAt = [...assistantChildren, ...toolChildren, ...multitaskChildren]
    .map((c) => c.createdAt)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort()[0];
  // Hover footer content: the turn's assistant prose for Copy, and a fork
  // handler when the provider supports forking a resumed conversation.
  const turnMarkdown = item.assistantEvents
    .map((event) => event.message)
    .filter((message) => message.length > 0)
    .join("\n\n");
  // Mirror `fork_session`'s gate (orchestration.rs): a mid-turn fork would copy
  // a partial transcript, so the backend refuses "running" and "waiting". The
  // footer only hides itself on the *latest* live turn, so without this every
  // earlier turn — and every turn of a waiting session — offered a button whose
  // only possible outcome was an error toast.
  // Files this turn wrote, folded one row per path. Derived from the same tool
  // input the activity rows read, so the card cannot disagree with them.
  const turnChanges = useMemo(
    () => collectTurnFileChanges(visibleToolItems),
    [visibleToolItems]
  );
  const changesCard =
    turnChanges.length > 0 ? (
      <TurnChangesCard
        changes={turnChanges}
        workspaceCwd={workspace?.path ?? null}
        defaultExpanded={defaultTurnChangesExpanded ?? true}
        {...(onOpenDiff ? { onOpenDiff } : {})}
        {...(onOpenFile ? { onOpenFile } : {})}
        {...(onOpenReview ? { onOpenReview } : {})}
      />
    ) : null;
  const forkable =
    session !== null &&
    FORK_CAPABLE_PROVIDERS.has(session.provider) &&
    session.state !== "running" &&
    session.state !== "waiting" &&
    onForkSession !== undefined;
  return (
    <TurnBlock
      key={item.id}
      toolItems={visibleToolItems}
      assistantTimestamps={item.assistantTimestamps}
      {...(Number.isFinite(turnStartedAtMs) ? { turnStartedAtMs } : {})}
      isTurnActive={isTurnLiveTicking}
      toolsExpanded={toolsExpanded}
      onToggleTools={() => setToolsExpandOverride(!toolsExpanded)}
      hideWorkingWhenCollapsed={minimalActivity}
      body={bodyChildren}
      {...(earliestCreatedAt ? { headerTimestampIso: earliestCreatedAt } : {})}
      {...(turnMarkdown ? { turnMarkdown } : {})}
      {...(changesCard ? { changes: changesCard } : {})}
      {...(forkable && session ? { onFork: () => void onForkSession?.(session.id) } : {})}
    />
  );
}

// Memoized so a render of the parent SessionConversation (e.g. a composer
// keystroke, or a delta for a different turn) only re-renders turns whose props
// actually changed. Default shallow comparison is sufficient because every prop
// is referentially stable across a parent render that didn't touch this turn.
export const SessionConversationTurn = memo(SessionConversationTurnInner);

/**
 * Mark up a sent message the way the composer showed it while it was typed:
 * `/skill` invocations tinted, and pasted URLs clickable.
 *
 * A leading invocation names the whole message and keeps the icon chip; every
 * other token is only tinted. Shape is the whole guard — the transcript has no
 * skills list to check against — so the worst a false positive costs here is
 * one tinted word, never a chip that claims a skill ran.
 */
function markUserMessage(message: string): ReactNode {
  const leading = leadingSkillInvocation(message);
  const rest = leading ? leading.rest : message;
  const body = markLinks(rest);
  if (!leading) return body;
  const label = leading.name.charAt(0).toUpperCase() + leading.name.slice(1);
  return (
    <>
      <span className="user-skill-chip" title={`/${leading.name}`}>
        <Sparkles size={12} aria-hidden />
        {label}
      </span>
      {leading.rest ? <> {body}</> : null}
    </>
  );
}

/**
 * A URL is linked before its text is scanned for skill tokens, so a path
 * segment inside `https://host/plan` never renders as an invocation.
 */
function markLinks(text: string): ReactNode {
  const segments = splitLinkSegments(text);
  if (!segments) return markSkillTokens(text);
  return segments.map((segment, index) =>
    segment.link ? (
      <WebLink key={index} href={segment.text}>
        {segment.text}
      </WebLink>
    ) : (
      <Fragment key={index}>{markSkillTokens(segment.text)}</Fragment>
    )
  );
}

function markSkillTokens(text: string): ReactNode {
  const segments = splitSkillTokens(text, () => true);
  if (!segments) return text;
  return segments.map((segment, index) =>
    segment.skill ? (
      <span key={index} className="user-skill-token">
        {segment.text}
      </span>
    ) : (
      segment.text
    )
  );
}

/** The session an incoming `user.message` was written by, not typed in. */
interface UserMessageOrigin {
  sessionId: string;
  label: string;
}

/**
 * Reads the `origin` block Rust writes onto a message that arrived from
 * another session. Either identifier missing (or blank) means there is no
 * chat to name or open, so the message renders as an ordinary user bubble
 * rather than a header pointing nowhere.
 */
function readMessageOrigin(payload: unknown): UserMessageOrigin | null {
  if (typeof payload !== "object" || payload === null) return null;
  const origin = (payload as { origin?: unknown }).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const { sessionId, label } = origin as { sessionId?: unknown; label?: unknown };
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
  if (typeof label !== "string" || label.trim().length === 0) return null;
  return { sessionId, label: label.trim() };
}

/** User-message row from a render item (not a turn). */
export function SessionConversationUserMessage({
  event,
  attachments,
  isTurnAnchor = false,
  onOpenSession
}: {
  event: Extract<RenderItem, { kind: "user-message" }>["event"];
  attachments: UserMessageAttachment[];
  isTurnAnchor?: boolean;
  /** Focuses another session's chat, for a message that came from one. Absent
   *  on hosts with no way to reach a second chat, which leaves the header's
   *  label as plain text. */
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  const origin = readMessageOrigin(event.payload);
  let displayMessage = event.message;
  for (const a of attachments) {
    displayMessage = displayMessage.split(`@${a.filePath}`).join("");
  }
  displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <div
      className="user-message-group"
      {...(isTurnAnchor ? { "data-turn-anchor": "true" } : {})}
      {...(origin ? { role: "article", "aria-label": "Message from another chat" } : {})}
    >
      {origin ? (
        <div className="user-message-origin">
          From{" "}
          {onOpenSession ? (
            <button
              type="button"
              className="user-message-origin-open"
              aria-label={`Open chat: ${origin.label}`}
              title={`Open chat: ${origin.label}`}
              onClick={() => onOpenSession(origin.sessionId)}
            >
              {origin.label}
            </button>
          ) : (
            <span className="user-message-origin-label" title={origin.label}>
              {origin.label}
            </span>
          )}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="user-message-attachments" aria-label="Attachments">
          {attachments.map((a) => {
            const filename = a.filePath.split("/").pop() || a.filePath;
            if (isSupportedImageMime(a.mimeType)) {
              const url = attachmentProtocolUrl(a.filePath);
              return (
                <figure
                  key={a.filePath}
                  className="user-message-attachment-preview"
                  title={a.filePath}
                >
                  <button
                    type="button"
                    className="attachment-open-button"
                    aria-label={`View image: ${filename}`}
                    onClick={() => setLightboxSrc(url)}
                  >
                    <img
                      className="user-message-attachment-image"
                      src={url}
                      alt={`Attached image: ${filename}`}
                    />
                  </button>
                </figure>
              );
            }
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
      {displayMessage ? (
        <ChatBubble
          key={event.id}
          kind="user"
          rawMarkdown={displayMessage}
        >
          {/* The raw text (with the slashes) stays in rawMarkdown so copy
              keeps the real message. */}
          <p>{markUserMessage(displayMessage)}</p>
        </ChatBubble>
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </div>
  );
}
