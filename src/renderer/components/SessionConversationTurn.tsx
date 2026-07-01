import { memo, useState, type JSX, type MutableRefObject } from "react";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { parsePlan } from "../lib/parsePlan.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { isSupportedImageMime } from "../lib/composerAttachments.js";
import { buildTurnRenderState } from "../lib/sessionTurnView.js";
import type { TurnToolItem } from "../lib/toolCalls.js";
import { visibleTurnToolItem } from "../lib/turnToolItems.js";
import { sessionAgentModeKey, writeStoredAgentMode } from "../lib/agentMode.js";
import type { AgentMode } from "../../shared/types.js";
import { ChatBubble } from "./ChatBubble.js";
import { PlanCard } from "./PlanCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { ThoughtBlock } from "./ThoughtBlock.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { ToolCallRow } from "./ToolCallRow.js";
import { TurnBlock, type TurnBodyChild } from "./TurnBlock.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import {
  sendAfterTerminate,
  type SessionConversationSendInput,
  type UserMessageAttachment
} from "./sessionConversationHelpers.js";
import type { FileChipOpenOptions } from "./FileChip.js";

type TurnRenderItem = Extract<RenderItem, { kind: "turn" }>;

function SessionConversationTurnInner({
  item,
  priorItem,
  isLatestTurn,
  showModelHeader,
  session,
  selectedModel,
  workspace,
  onOpenFile,
  onTerminateSession,
  onSendSessionInput,
  inputRef,
  shouldRefocusInput,
  setStatus,
  setAgentMode,
  defaultToolCallsExpanded,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded
}: {
  item: TurnRenderItem;
  priorItem: RenderItem | null;
  isLatestTurn: boolean;
  showModelHeader: boolean;
  session: SessionSummary | null;
  selectedModel: ModelPickerSelection;
  workspace: WorkspaceSummary | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onSendSessionInput: SessionConversationSendInput;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  shouldRefocusInput: MutableRefObject<boolean>;
  setStatus: (message: string | null) => void;
  setAgentMode: (mode: AgentMode) => void;
  defaultToolCallsExpanded?: boolean;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
}): JSX.Element {
  const turnView = buildTurnRenderState({
    assistantEvents: item.assistantEvents,
    toolItems: item.toolItems,
    priorItem,
    assistantTimestamps: item.assistantTimestamps
  });
  const {
    visibleAssistantGroups,
    turnAgentMode,
    exitPlanTool,
    askUserQuestionTool,
    hiddenToolIds,
    turnStartedAtMs,
    isPausedOnUserInput
  } = turnView;
  // A Thought block is "live" (shown expanded, in place of the thinking verbs)
  // while this turn is actively working and hasn't produced its answer yet.
  // Once any answer text lands — or the turn stops being the active one, or it
  // pauses for user input — it falls back to the saved expanded-by-default
  // setting for quiet, persistent "Thought" history.
  const sessionIsLive = session?.state === "running";
  const turnHasAnswerText = visibleAssistantGroups.some(
    (group) => !group.thinking && group.text.trim().length > 0
  );
  const thinkingLive = isLatestTurn && sessionIsLive && !isPausedOnUserInput && !turnHasAnswerText;
  // Tool groups expand by default for the current turn (you're watching it
  // work, and it stays open through completion so nothing collapses out from
  // under the answer) and collapse to headers for older turns. The turn chip
  // toggles this for the whole turn; collapsing folds the tool groups to their
  // headers AND the Thought block, so one control governs the turn's reasoning
  // and its tools. Nothing is removed from the chat. A per-row chevron still
  // overrides an individual group or the Thought block.
  const toolsExpandedDefault = isLatestTurn
    ? (defaultToolCallGroupsExpanded ?? defaultToolCallsExpanded ?? false)
    : false;
  const [toolsExpandOverride, setToolsExpandOverride] = useState<boolean | null>(null);
  const toolsExpanded = toolsExpandOverride ?? toolsExpandedDefault;
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
      setStatus
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
  type AnnotatedChild = TurnBodyChild & { createdAt: string; sortAt: string };
  const assistantChildren: AnnotatedChild[] = visibleAssistantGroups.map((group) => {
    if (group.thinking) {
      const node = (
        <ThoughtBlock
          key={group.id}
          defaultExpanded={toolsExpandOverride ?? defaultThinkingExpanded}
          live={thinkingLive}
        >
          <StreamingMarkdown
            text={group.text}
            streaming={false}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        </ThoughtBlock>
      );
      return { kind: "assistant", id: group.id, node, createdAt: group.createdAt, sortAt: group.lastActivityAt };
    }
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
          workspace={workspace}
          onOpenFile={onOpenFile}
        />
      </ChatBubble>
    );
    return { kind: "assistant", id: group.id, node, createdAt: group.createdAt, sortAt: group.lastActivityAt };
  });
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
  const visibleToolItems = item.toolItems
    .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
    .filter((tItem): tItem is TurnToolItem => tItem !== null);
  const isTurnLiveTicking = isLatestTurn && sessionIsLive && !isPausedOnUserInput;
  const toolChildren: AnnotatedChild[] = visibleToolItems
    .map((tItem) => {
      if (tItem.kind === "tool") {
        return {
          kind: "tool",
          id: tItem.tool.id,
          createdAt: tItem.tool.createdAt,
          sortAt: tItem.tool.createdAt,
          node: (
            <ToolCallRow
              tool={tItem.tool}
              defaultExpanded={toolsExpanded}
              workspaceCwd={workspace?.path ?? null}
              onOpenFile={onOpenFile}
            />
          )
        };
      }
      const firstCreatedAt = tItem.group.tools[0]?.createdAt ?? "";
      return {
        kind: "tool",
        id: tItem.group.id,
        createdAt: firstCreatedAt,
        sortAt: firstCreatedAt,
        node: (
          <ToolCallGroupBubble
            group={tItem.group}
            defaultExpanded={toolsExpanded}
            workspaceCwd={workspace?.path ?? null}
            onOpenFile={onOpenFile}
          />
        )
      };
    });
  const bodyChildren: TurnBodyChild[] = [...assistantChildren, ...toolChildren]
    .sort((a, b) => {
      const cmp = a.sortAt.localeCompare(b.sortAt);
      if (cmp !== 0) return cmp;
      // Cursor can emit a narration delta and the tool start in the same
      // millisecond. The delta is the thing the user should read first.
      return (a.kind === "assistant" ? -1 : 0) - (b.kind === "assistant" ? -1 : 0);
    })
    .map(({ kind, id, node }) => ({ kind, id, node }));
  const earliestCreatedAt = [...assistantChildren, ...toolChildren]
    .map((c) => c.createdAt)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort()[0];
  return (
    <TurnBlock
      key={item.id}
      toolItems={visibleToolItems}
      assistantTimestamps={item.assistantTimestamps}
      {...(showModelHeader ? { modelLabel: selectedModel.label } : {})}
      {...(Number.isFinite(turnStartedAtMs) ? { turnStartedAtMs } : {})}
      isTurnActive={isTurnLiveTicking}
      toolsExpanded={toolsExpanded}
      onToggleTools={() => setToolsExpandOverride(!toolsExpanded)}
      body={bodyChildren}
      {...(earliestCreatedAt ? { headerTimestampIso: earliestCreatedAt } : {})}
    />
  );
}

// Memoized so a render of the parent SessionConversation (e.g. a composer
// keystroke, or a delta for a different turn) only re-renders turns whose props
// actually changed. Default shallow comparison is sufficient because every prop
// is referentially stable across a parent render that didn't touch this turn.
export const SessionConversationTurn = memo(SessionConversationTurnInner);

/** User-message row from a render item (not a turn). */
export function SessionConversationUserMessage({
  event,
  attachments
}: {
  event: Extract<RenderItem, { kind: "user-message" }>["event"];
  attachments: UserMessageAttachment[];
}): JSX.Element {
  let displayMessage = event.message;
  for (const a of attachments) {
    displayMessage = displayMessage.split(`@${a.filePath}`).join("");
  }
  displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
  return (
    <div className="user-message-group">
      {attachments.length > 0 ? (
        <div className="user-message-attachments" aria-label="Attachments">
          {attachments.map((a) => {
            const filename = a.filePath.split("/").pop() || a.filePath;
            if (isSupportedImageMime(a.mimeType)) {
              return (
                <figure
                  key={a.filePath}
                  className="user-message-attachment-preview"
                  title={a.filePath}
                >
                  <img
                    className="user-message-attachment-image"
                    src={attachmentProtocolUrl(a.filePath)}
                    alt={`Attached image: ${filename}`}
                  />
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
          <p>{displayMessage}</p>
        </ChatBubble>
      ) : null}
    </div>
  );
}
