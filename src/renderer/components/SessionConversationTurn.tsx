import type { JSX, MutableRefObject } from "react";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import { parsePlan } from "../lib/parsePlan.js";
import type { RenderItem } from "../lib/foldConversation.js";
import { buildTurnRenderState } from "../lib/sessionTurnView.js";
import type { ToolCall, TurnToolItem } from "../lib/toolCalls.js";
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
import {
  sendAfterTerminate,
  StreamingMarkdown,
  type SessionConversationSendInput
} from "./sessionConversationHelpers.js";
import type { FileChipOpenOptions } from "./FileChip.js";

type TurnRenderItem = Extract<RenderItem, { kind: "turn" }>;

export function SessionConversationTurn({
  item,
  index,
  renderItems,
  turnShowsModelHeader,
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
  isFreshTool
}: {
  item: TurnRenderItem;
  index: number;
  renderItems: RenderItem[];
  turnShowsModelHeader: Map<number, boolean>;
  session: SessionSummary | null;
  selectedModel: ProviderModelSelection;
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
  isFreshTool: (tool: ToolCall) => boolean;
}): JSX.Element {
  const priorItem = index > 0 ? renderItems[index - 1] : null;
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
  // pauses for user input — it auto-collapses to a quiet, persistent chip.
  const isLatestTurn = index === renderItems.length - 1;
  const sessionIsLive = session?.state === "running";
  const turnHasAnswerText = visibleAssistantGroups.some(
    (group) => !group.thinking && group.text.trim().length > 0
  );
  const thinkingLive = isLatestTurn && sessionIsLive && !isPausedOnUserInput && !turnHasAnswerText;
  const handlePlanAccept = (): void => {
    if (!session) return;
    setAgentMode("auto");
    writeStoredAgentMode(sessionAgentModeKey(session.id), "auto");
    shouldRefocusInput.current = true;
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
  const handleQuestionAnswer = (answerMarkdown: string): void => {
    if (!session) return;
    shouldRefocusInput.current = true;
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
  type AnnotatedChild = TurnBodyChild & { createdAt: string };
  const assistantChildren: AnnotatedChild[] = visibleAssistantGroups.map((group) => {
    if (group.thinking) {
      const node = (
        <ThoughtBlock key={group.id} live={thinkingLive}>
          <StreamingMarkdown
            text={group.text}
            streaming={false}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        </ThoughtBlock>
      );
      return { kind: "assistant", id: group.id, node, createdAt: group.createdAt };
    }
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
  const visibleToolItems = item.toolItems
    .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
    .filter((tItem): tItem is TurnToolItem => tItem !== null);
  const anyToolRunningInTurn = visibleToolItems.some((tItem) =>
    tItem.kind === "tool"
      ? tItem.tool.status === "running"
      : tItem.group.tools.some((tool) => tool.status === "running")
  );
  const turnIsActive = anyToolRunningInTurn || (isLatestTurn && sessionIsLive);
  const isTurnLiveTicking = isLatestTurn && sessionIsLive && !isPausedOnUserInput;
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
  const bodyChildren: TurnBodyChild[] = [...assistantChildren, ...toolChildren]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ kind, id, node }) => ({ kind, id, node }));
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
}

/** User-message row from a render item (not a turn). */
export function SessionConversationUserMessage({
  event,
  attachments
}: {
  event: Extract<RenderItem, { kind: "user-message" }>["event"];
  attachments: { filePath: string; mimeType: string }[];
}): JSX.Element {
  let displayMessage = event.message;
  for (const a of attachments) {
    displayMessage = displayMessage.split(`@${a.filePath}`).join("");
  }
  displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
  return (
    <ChatBubble
      key={event.id}
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

export function parseUserMessageAttachments(
  item: Extract<RenderItem, { kind: "user-message" }>
): { filePath: string; mimeType: string }[] {
  const rawAttachments = arrayValue(item.event.payload.attachments) ?? [];
  return rawAttachments
    .map((entry) => {
      const obj = objectValue(entry);
      const filePath = stringValue(obj?.filePath);
      const mimeType = stringValue(obj?.mimeType);
      if (!filePath || !mimeType) return null;
      return { filePath, mimeType };
    })
    .filter((value): value is { filePath: string; mimeType: string } => Boolean(value));
}
