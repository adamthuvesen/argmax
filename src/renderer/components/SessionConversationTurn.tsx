import { memo, useState, type JSX, type MutableRefObject } from "react";
import { Sparkles } from "lucide-react";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { FORK_CAPABLE_PROVIDERS } from "../../shared/providerModels.js";
import { leadingSkillInvocation } from "../lib/slashHighlight.js";
import { ImageLightbox } from "./ImageLightbox.js";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { parsePlan } from "../lib/parsePlan.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { isSupportedImageMime } from "../lib/composerAttachments.js";
import { buildTurnRenderState, liveThoughtOwnsProgress } from "../lib/sessionTurnView.js";
import { isAgentToolName, type ToolCall, type TurnToolItem } from "../lib/toolCalls.js";
import type { ToolCallsDisplay } from "../lib/uiPreferences.js";
import { codenameForTool } from "../lib/agentNames.js";
import { visibleTurnToolItem } from "../lib/turnToolItems.js";
import { sessionAgentModeKey, writeStoredAgentMode } from "../lib/agentMode.js";
import { thoughtDurationMs } from "../formatElapsed.js";
import type { AgentMode } from "../../shared/types.js";
import { AgentLaunchList } from "./AgentLaunchList.js";
import { ActivitySummaryLine } from "./ActivitySummaryLine.js";
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
import type { ComposerStatus } from "./SessionComposer.js";

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
  onTerminateSession,
  onForkSession,
  onSendSessionInput,
  inputRef,
  shouldRefocusInput,
  setStatus,
  setAgentMode,
  defaultToolCallsDisplay,
  defaultToolCallGroupsExpanded,
  defaultThinkingExpanded
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
  onTerminateSession: (sessionId: string) => Promise<void>;
  onForkSession?: (sessionId: string) => Promise<void>;
  onSendSessionInput: SessionConversationSendInput;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  shouldRefocusInput: MutableRefObject<boolean>;
  setStatus: (status: ComposerStatus | null) => void;
  setAgentMode: (mode: AgentMode) => void;
  defaultToolCallsDisplay?: ToolCallsDisplay;
  defaultToolCallGroupsExpanded?: boolean;
  defaultThinkingExpanded?: boolean;
}): JSX.Element {
  const sessionIsLive = session?.state === "running";
  const turnView = buildTurnRenderState({
    assistantEvents: item.assistantEvents,
    toolItems: item.toolItems,
    priorItem,
    assistantTimestamps: item.assistantTimestamps,
    isStreamingTurn: isLatestTurn && sessionIsLive
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
  // and its tools. Nothing is removed from the chat. A per-row chevron still
  // overrides an individual group or the Thought block. "Tool call groups"
  // still wins over "Tool calls in chat" when it is set, so groups can open
  // while the tool rows stay collapsed. Single-line mode ("cleanest") never
  // expands: tool runs render as one self-updating line.
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
  const assistantChildren: AnnotatedChild[] = visibleAssistantGroups
    .map((group): AnnotatedChild | null => {
      // Single-line mode folds completed Thought blocks away entirely — only
      // the live "Thinking" indicator (governed by thinkingLive) survives.
      if (minimalActivity && group.thinking && !thinkingLive) return null;
      if (group.thinking) {
        const node = (
          <ThoughtBlock
            key={group.id}
            defaultExpanded={toolsExpandOverride ?? defaultThinkingExpanded}
            live={thinkingLive}
            holdOpen={isLatestTurn && toolsExpandOverride !== false}
            durationMs={thoughtDurationMs(group.createdAt, group.lastActivityAt)}
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
  const visibleToolItems = item.toolItems
    .map((tItem) => visibleTurnToolItem(tItem, hiddenToolIds))
    .filter((tItem): tItem is TurnToolItem => tItem !== null);
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
  const sortedChildren = [...assistantChildren, ...toolChildren]
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
  // allowed between replies. The merged child anchors on the run's first tool
  // id so the line mutates in place ("Read 1 file" → "Read 2 files, edited 1
  // file") as the run grows instead of appending.
  let bodySource: AnnotatedChild[] = coalescedChildren;
  if (minimalActivity) {
    const activityChildren: AnnotatedChild[] = [];
    let run: { tools: ToolCall[]; anchor: AnnotatedChild } | null = null;
    const flushRun = (): void => {
      if (!run) return;
      const { tools, anchor } = run;
      run = null;
      const first = tools[0];
      // A run of one has nothing to summarize: the line and the row it hides
      // are the same sentence with different pluralization ("Fetched 1 URL"
      // over "Fetched URL"). Show the row, which opens straight to detail.
      const only = tools.length === 1 ? first : undefined;
      activityChildren.push({
        kind: "tool",
        id: first ? `activity-${first.id}` : anchor.id,
        createdAt: anchor.createdAt,
        sortAt: anchor.sortAt,
        node: only ? (
          <ToolCallRow
            tool={only}
            workspaceCwd={workspace?.path ?? null}
            agentCodename={codenameForTool(only, agentCodenames)}
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
      });
    };
    for (const child of coalescedChildren) {
      if (child.kind === "tool" && child.runTools && child.runTools.length > 0) {
        if (run) run.tools.push(...child.runTools);
        else run = { tools: [...child.runTools], anchor: child };
        continue;
      }
      flushRun();
      activityChildren.push(child);
    }
    flushRun();
    bodySource = activityChildren;
  }
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
            defaultExpanded={toolsExpanded}
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
  const earliestCreatedAt = [...assistantChildren, ...toolChildren]
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
      body={bodyChildren}
      {...(earliestCreatedAt ? { headerTimestampIso: earliestCreatedAt } : {})}
      {...(turnMarkdown ? { turnMarkdown } : {})}
      {...(forkable && session ? { onFork: () => void onForkSession?.(session.id) } : {})}
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
  attachments,
  isTurnAnchor = false
}: {
  event: Extract<RenderItem, { kind: "user-message" }>["event"];
  attachments: UserMessageAttachment[];
  isTurnAnchor?: boolean;
}): JSX.Element {
  let displayMessage = event.message;
  for (const a of attachments) {
    displayMessage = displayMessage.split(`@${a.filePath}`).join("");
  }
  displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <div className="user-message-group" {...(isTurnAnchor ? { "data-turn-anchor": "true" } : {})}>
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
          <p>
            {(() => {
              // A message sent as `/skill args` renders the invocation as an
              // accent-colored chip so a skill run reads differently from
              // plain prose. The raw text (with the slash) stays in
              // rawMarkdown so copy keeps the real message.
              const skill = leadingSkillInvocation(displayMessage);
              if (!skill) return displayMessage;
              const label = skill.name.charAt(0).toUpperCase() + skill.name.slice(1);
              return (
                <>
                  <span className="user-skill-chip" title={`/${skill.name}`}>
                    <Sparkles size={12} aria-hidden />
                    {label}
                  </span>
                  {skill.rest ? ` ${skill.rest}` : null}
                </>
              );
            })()}
          </p>
        </ChatBubble>
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </div>
  );
}
