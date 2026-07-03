import type { TimelineEvent } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import type { RenderItem } from "./foldConversation.js";
import { parsePlan } from "./parsePlan.js";
import {
  collectAskUserQuestionState,
  collectExitPlanState,
  type ResolvedAskUserQuestionTool,
  type ResolvedExitPlanTool
} from "./turnInteractiveCards.js";
import type { TurnToolItem } from "./toolCalls.js";

export type AssistantGroup = {
  id: string;
  createdAt: string;
  // Timestamp of the group's LAST delta. A streamed answer's first delta can
  // predate the turn's tool calls (Cursor streams the assistant message
  // cumulatively from the turn's start), so ordering by `createdAt` would float
  // the answer above the tools it actually follows. Sort the turn body by
  // `lastActivityAt` instead, so a streaming group settles below earlier tools —
  // matching how a completed message (anchored at its end) already sorts.
  lastActivityAt: string;
  text: string;
  streaming: boolean;
  // Claude extended-thinking content, surfaced by the normalizer as a
  // message.delta with payload.thinking === true. Rendered as a separate
  // collapsible "Thought" block rather than inline answer text.
  thinking?: boolean;
};

function isThinkingDelta(event: TimelineEvent): boolean {
  return event.type === "message.delta" && event.payload?.["thinking"] === true;
}

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

/**
 * Append a streamed thinking fragment. `thinking_delta` fragments are disjoint,
 * so they append normally. The final complete thinking block (from the whole
 * assistant message) re-sends the FULL reasoning (= sum of the fragments);
 * `startsWith` is then true and the slice is empty, so it dedups to a no-op
 * instead of doubling the text. If increments never arrived (no partial
 * streaming) the buffer is empty and the complete block appends in full.
 */
function appendThinking(current: string, incoming: string): string {
  return incoming.startsWith(current)
    ? current + incoming.slice(current.length)
    : current + incoming;
}

/**
 * Fold streamed `message.delta` events into assistant groups. Answer fragments
 * and extended-thinking fragments are accumulated into SEPARATE growing groups
 * (thinking renders in the collapsible Thought block); the open buffer is
 * flushed whenever the kind flips so they never concatenate.
 */
export function coalesceAssistantGroups(
  assistantEvents: readonly TimelineEvent[],
  options: { splitAt?: readonly string[]; streaming?: boolean } = {}
): AssistantGroup[] {
  const assistantGroups: AssistantGroup[] = [];
  type Buffer = { id: string; createdAt: string; lastCreatedAt: string; text: string };
  let answerBuffer: Buffer | null = null;
  let thinkingBuffer: Buffer | null = null;
  let previousEventCreatedAt: string | null = null;
  const splitAt = options.splitAt ?? [];
  const streaming = options.streaming ?? true;
  let groupIndex = 0;
  const nextGroupId = (kind: "answer" | "thinking"): string => `assistant-${kind}-${groupIndex++}`;
  const flushAnswer = (): void => {
    if (!answerBuffer) return;
    assistantGroups.push({
      id: answerBuffer.id,
      createdAt: answerBuffer.createdAt,
      lastActivityAt: answerBuffer.lastCreatedAt,
      text: answerBuffer.text,
      streaming
    });
    answerBuffer = null;
  };
  const flushThinking = (): void => {
    if (!thinkingBuffer) return;
    assistantGroups.push({
      id: thinkingBuffer.id,
      createdAt: thinkingBuffer.createdAt,
      lastActivityAt: thinkingBuffer.lastCreatedAt,
      text: thinkingBuffer.text,
      streaming: false,
      thinking: true
    });
    thinkingBuffer = null;
  };
  const splitBefore = (event: TimelineEvent): boolean => {
    const previous = previousEventCreatedAt;
    return previous !== null && splitAt.some((time) => time >= previous && time < event.createdAt);
  };
  for (const event of assistantEvents) {
    if (splitBefore(event)) {
      flushThinking();
      flushAnswer();
    }
    if (isThinkingDelta(event)) {
      flushAnswer();
      if (!thinkingBuffer) {
        thinkingBuffer = {
          id: nextGroupId("thinking"),
          createdAt: event.createdAt,
          lastCreatedAt: event.createdAt,
          text: ""
        };
      }
      thinkingBuffer.lastCreatedAt = event.createdAt;
      thinkingBuffer.text = appendThinking(thinkingBuffer.text, event.message);
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    if (event.type === "message.delta") {
      flushThinking();
      if (!answerBuffer) {
        answerBuffer = {
          id: nextGroupId("answer"),
          createdAt: event.createdAt,
          lastCreatedAt: event.createdAt,
          text: ""
        };
      }
      answerBuffer.lastCreatedAt = event.createdAt;
      answerBuffer.text += deltaTextForBuffer(event, answerBuffer.text);
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    flushThinking();
    flushAnswer();
    const last = assistantGroups[assistantGroups.length - 1];
    if (
      last &&
      !last.streaming &&
      last.text === event.message &&
      event.type === "message.completed"
    ) {
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    assistantGroups.push({
      id: nextGroupId("answer"),
      createdAt: event.createdAt,
      lastActivityAt: event.createdAt,
      text: event.message,
      streaming: false
    });
    previousEventCreatedAt = event.createdAt;
  }
  flushThinking();
  flushAnswer();
  return assistantGroups;
}

function toolStartTimes(toolItems: readonly TurnToolItem[]): string[] {
  const times: string[] = [];
  for (const item of toolItems) {
    if (item.kind === "tool") {
      times.push(item.tool.createdAt);
      continue;
    }
    for (const tool of item.group.tools) {
      times.push(tool.createdAt);
    }
  }
  return times.sort();
}

/** Earliest card cutoff when plan/question cards are the turn's authoritative artifact. */
export function cardCutoffForTurn(params: {
  exitPlanCreatedAt: string | null;
  questionCreatedAt: string | null;
}): string | null {
  const cardCutoffs = [params.exitPlanCreatedAt, params.questionCreatedAt].filter(
    (t): t is string => t !== null
  );
  return cardCutoffs.length > 0 ? cardCutoffs.reduce((a, b) => (a < b ? a : b)) : null;
}

export function turnAgentModeFromPrior(priorItem: RenderItem | null): string | null {
  return priorItem && priorItem.kind === "user-message"
    ? stringValue(priorItem.event.payload.agentMode)
    : null;
}

export function computeTurnStartedAtMs(params: {
  priorItem: RenderItem | null;
  assistantTimestamps: readonly number[];
  toolItems: readonly TurnToolItem[];
}): number {
  if (params.priorItem && params.priorItem.kind === "user-message") {
    const parsed = Date.parse(params.priorItem.event.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  let earliest = Number.POSITIVE_INFINITY;
  for (const ts of params.assistantTimestamps) {
    if (Number.isFinite(ts)) earliest = Math.min(earliest, ts);
  }
  for (const tItem of params.toolItems) {
    const tools = tItem.kind === "tool" ? [tItem.tool] : tItem.group.tools;
    for (const t of tools) {
      const s = Date.parse(t.createdAt);
      if (Number.isFinite(s)) earliest = Math.min(earliest, s);
    }
  }
  return Number.isFinite(earliest) ? earliest : Number.NaN;
}

export type TurnRenderState = {
  assistantGroups: AssistantGroup[];
  visibleAssistantGroups: AssistantGroup[];
  cardCutoff: string | null;
  turnAgentMode: string | null;
  exitPlanTool: ResolvedExitPlanTool | null;
  exitPlanHiddenToolIds: Set<string>;
  askUserQuestionTool: ResolvedAskUserQuestionTool | null;
  askUserQuestionHiddenToolIds: Set<string>;
  hiddenToolIds: Set<string>;
  hasExitPlanCard: boolean;
  hasQuestionCard: boolean;
  turnStartedAtMs: number;
  isPausedOnUserInput: boolean;
};

export function buildTurnRenderState(params: {
  assistantEvents: readonly TimelineEvent[];
  toolItems: readonly TurnToolItem[];
  priorItem: RenderItem | null;
  assistantTimestamps: readonly number[];
  isStreamingTurn?: boolean;
}): TurnRenderState {
  const assistantGroups = coalesceAssistantGroups(params.assistantEvents, {
    splitAt: toolStartTimes(params.toolItems),
    streaming: params.isStreamingTurn ?? true
  });
  const { tool: exitPlanTool, hiddenToolIds: exitPlanHiddenToolIds } = collectExitPlanState(
    params.toolItems
  );
  const { tool: askUserQuestionTool, hiddenToolIds: askUserQuestionHiddenToolIds } =
    collectAskUserQuestionState(params.toolItems);
  const exitPlanHasPlan = exitPlanTool !== null && parsePlan(exitPlanTool.markdown) !== null;
  const hasQuestionCard = askUserQuestionTool !== null;
  const cardCutoff = cardCutoffForTurn({
    exitPlanCreatedAt: exitPlanHasPlan && exitPlanTool ? exitPlanTool.createdAt : null,
    questionCreatedAt: hasQuestionCard && askUserQuestionTool ? askUserQuestionTool.createdAt : null
  });
  const visibleAssistantGroups = cardCutoff
    ? assistantGroups.filter((g) => g.createdAt < cardCutoff)
    : assistantGroups;
  const hiddenToolIds = new Set([...exitPlanHiddenToolIds, ...askUserQuestionHiddenToolIds]);

  // A plan produced in the same turn as a still-unanswered question was written
  // before the user could answer (their answer starts the next turn) — so it's a
  // premature plan the model emitted when its denied AskUserQuestion fell back to
  // ExitPlanMode. Show only the question and drop the plan card; the agent re-plans
  // with the answer next turn. The plan's tool row + raw text stay hidden anyway
  // (via hiddenToolIds and the question-anchored cardCutoff).
  const planPrecededByQuestion =
    exitPlanHasPlan &&
    hasQuestionCard &&
    exitPlanTool !== null &&
    askUserQuestionTool !== null &&
    askUserQuestionTool.createdAt <= exitPlanTool.createdAt;
  const renderedExitPlanTool = planPrecededByQuestion ? null : exitPlanTool;

  return {
    assistantGroups,
    visibleAssistantGroups,
    cardCutoff,
    turnAgentMode: turnAgentModeFromPrior(params.priorItem),
    exitPlanTool: renderedExitPlanTool,
    exitPlanHiddenToolIds,
    askUserQuestionTool,
    askUserQuestionHiddenToolIds,
    hiddenToolIds,
    hasExitPlanCard: renderedExitPlanTool !== null,
    hasQuestionCard,
    turnStartedAtMs: computeTurnStartedAtMs({
      priorItem: params.priorItem,
      assistantTimestamps: params.assistantTimestamps,
      toolItems: params.toolItems
    }),
    isPausedOnUserInput: askUserQuestionTool !== null || exitPlanTool !== null
  };
}
