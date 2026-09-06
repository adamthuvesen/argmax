import type { TimelineEvent } from "../../shared/types.js";
import { stringValue } from "../../shared/typeGuards.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import type { RenderItem } from "./foldConversation.js";
import { isNoisyProviderTracing, matchTracingRecord, parseLogDump, splitLogSegments } from "./logDump.js";
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
  /** Revealed live: this is the newest group of a turn still running, so it is
      the one the typewriter animates. Earlier groups of the same turn were
      closed by a tool call, a thinking switch, or an error and can never grow
      again, so they render settled. */
  streaming: boolean;
  /** Folded from deltas in a live turn, with no completed message yet — so the
      text may be mid-sentence. Read only to defer parsing a plan out of the
      block; it is not cleared when the group is closed, because deferring is
      the safe side of that call. A block that landed whole is never growing, so
      a plan in it can be parsed at once. */
  growing?: boolean;
  // Claude extended-thinking content, decoded as thinking instead of answer
  // text. Rendered as a separate collapsible "Thought" block.
  thinking?: boolean;
  // Stderr and other `error` timeline events. Rendered as a log block, not
  // an assistant bubble. Consecutive errors coalesce into one group.
  error?: boolean;
};

/**
 * Minimal verbosity, finished and collapsed: the prose Claude, Codex, Grok,
 * and OpenCode write before each tool is progress, not the answer, so it hides
 * with the tools it narrates. Returns the group ids to drop — everything at or
 * before the last tool except the last prose group, which is kept so collapsing
 * can never leave the chip standing over nothing. A surface that renders the
 * answer itself (the agent pane's result panel) passes `separateAnswer` and
 * keeps nothing.
 *
 * Claude and Grok emit that text and the following `command.started` from one
 * envelope, so they share a timestamp: same-timestamp prose counts as work.
 */
export function preToolNarrationGroupIds(
  groups: readonly AssistantGroup[],
  lastToolCreatedAt: string | null,
  options: { separateAnswer?: boolean } = {}
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (lastToolCreatedAt === null) return hidden;
  const lastAnswerId = options.separateAnswer
    ? undefined
    : [...groups].reverse().find((group) => !group.thinking && !group.error)?.id;
  for (const group of groups) {
    if (group.thinking || group.error) continue;
    if (group.id === lastAnswerId) continue;
    if (group.lastActivityAt <= lastToolCreatedAt) hidden.add(group.id);
  }
  return hidden;
}

function cursorAssistantSnapshot(event: TimelineEvent): string | null {
  const canonical = decodeTimelineEvent(event);
  return canonical.kind === "message" && canonical.phase === "delta"
    ? canonical.cumulativeText
    : null;
}

function deltaTextForBuffer(event: TimelineEvent, currentText: string): string {
  const snapshot = cursorAssistantSnapshot(event);
  if (snapshot === null) {
    return event.message;
  }
  // A tool split flushes the open buffer and opens a fresh one. Cursor's
  // payload still carries the turn-cumulative assistant text, but the
  // normalizer already emitted only the suffix in `event.message`. Diffing
  // against an empty buffer would re-import the whole cumulative snapshot and
  // repeat narration the prior group already rendered.
  if (currentText.length === 0) {
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
 * Grok (and sometimes Claude) closes a text block before a tool, then continues
 * the same sentence in the next assistant envelope. Leading whitespace on the
 * incoming fragment is the reliable join: `"I'll"` + `" read the docs."`.
 * A fragment that starts lowercase after a line that did not end a sentence
 * is the same split without the leading space.
 */
function isAnswerContinuation(previous: string, incoming: string): boolean {
  if (incoming.length === 0) return false;
  if (/^\s/.test(incoming)) return true;
  const prev = previous.trimEnd();
  if (prev.length === 0) return true;
  const last = prev.charAt(prev.length - 1);
  if (last === "\n" || ".!?…:".includes(last)) return false;
  const start = incoming.trimStart().charAt(0);
  return start.length > 0 && start === start.toLowerCase();
}

function joinAnswerFragments(previous: string, incoming: string): string {
  if (incoming.length === 0) return previous;
  if (previous.length === 0) return incoming;
  if (/^\s/.test(incoming) || /\s$/.test(previous)) return previous + incoming;
  return `${previous} ${incoming}`;
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
  type Buffer = { id: string; createdAt: string; lastCreatedAt: string; lastEventId: string; text: string };
  let answerBuffer: Buffer | null = null;
  let thinkingBuffer: Buffer | null = null;
  let previousEventCreatedAt: string | null = null;
  const splitAt = options.splitAt ?? [];
  const streaming = options.streaming ?? true;
  // Raw PTY tracing that the renderer already dropped as noise can be followed
  // by extra lines (apply_patch dumps the expected context). Keep dropping
  // those until a real protocol event arrives.
  let dropRawContinuations = false;
  // A group is keyed by the event that closed the group before it, not by its
  // position or its own first event. A positional key shifts for every later
  // group when an earlier one splits or the bounded event tail drops a whole
  // group; a first-event key shifts when the tail trims into the group. A
  // shifted key remounts the bubble: the entrance animation replays and a live
  // block's typed reveal restarts from nothing, so a pane pinned to the bottom
  // drops and regrows. The boundary event only changes when the group really
  // is a different group.
  let boundaryEventId = "start";
  const nextGroupId = (kind: "answer" | "thinking"): string => `assistant-${kind}-after-${boundaryEventId}`;
  // Groups folded from deltas, as opposed to built from one completed message.
  // A completed message that follows a delta group in a live turn is a fresh
  // block (Cursor narrates before a tool, then answers), never a duplicate or
  // a continuation of the text still streaming above it.
  const deltaGroupIds = new Set<string>();
  const isLiveDeltaGroup = (group: AssistantGroup | undefined): boolean =>
    group !== undefined && streaming && deltaGroupIds.has(group.id);
  const flushAnswer = (): void => {
    if (!answerBuffer) return;
    assistantGroups.push({
      id: answerBuffer.id,
      createdAt: answerBuffer.createdAt,
      lastActivityAt: answerBuffer.lastCreatedAt,
      text: answerBuffer.text,
      streaming,
      growing: streaming
    });
    deltaGroupIds.add(answerBuffer.id);
    boundaryEventId = answerBuffer.lastEventId;
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
    boundaryEventId = thinkingBuffer.lastEventId;
    thinkingBuffer = null;
  };
  const splitBefore = (event: TimelineEvent): boolean => {
    const previous = previousEventCreatedAt;
    return previous !== null && splitAt.some((time) => time >= previous && time < event.createdAt);
  };
  const pushErrorLine = (event: TimelineEvent, message: string): void => {
    const last = assistantGroups[assistantGroups.length - 1];
    if (last?.error) {
      last.text = `${last.text}\n${message}`;
      last.lastActivityAt = event.createdAt;
      boundaryEventId = event.id;
      return;
    }
    assistantGroups.push({
      id: nextGroupId("answer"),
      createdAt: event.createdAt,
      lastActivityAt: event.createdAt,
      text: message,
      streaming: false,
      error: true
    });
    boundaryEventId = event.id;
  };
  for (const event of assistantEvents) {
    const canonical = decodeTimelineEvent(event);
    if (splitBefore(event)) {
      flushThinking();
      flushAnswer();
    }
    const tracing = matchTracingRecord(event.message);
    if (
      canonical.kind === "error" ||
      (canonical.kind === "message" && canonical.phase === "delta" && tracing)
    ) {
      flushThinking();
      flushAnswer();
      if (tracing && isNoisyProviderTracing(tracing.target, tracing.message)) {
        dropRawContinuations = true;
        previousEventCreatedAt = event.createdAt;
        continue;
      }
      dropRawContinuations = false;
      const message = event.message.trim();
      if (message.length === 0 || parseLogDump(message).length === 0) {
        previousEventCreatedAt = event.createdAt;
        continue;
      }
      pushErrorLine(event, message);
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    if (
      canonical.kind === "message" &&
      canonical.phase === "delta" &&
      canonical.rawStream &&
      dropRawContinuations
    ) {
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    if (canonical.kind === "message" && canonical.phase === "delta" && canonical.rawStream) {
      const last = assistantGroups[assistantGroups.length - 1];
      if (last?.error) {
        const message = event.message.trim();
        if (message.length > 0) pushErrorLine(event, message);
        previousEventCreatedAt = event.createdAt;
        continue;
      }
    }
    dropRawContinuations = false;
    if (
      canonical.kind === "message" &&
      canonical.phase === "delta" &&
      canonical.content === "thinking"
    ) {
      flushAnswer();
      if (!thinkingBuffer) {
        thinkingBuffer = {
          id: nextGroupId("thinking"),
          createdAt: event.createdAt,
          lastCreatedAt: event.createdAt,
          lastEventId: event.id,
          text: ""
        };
      }
      thinkingBuffer.lastCreatedAt = event.createdAt;
      thinkingBuffer.lastEventId = event.id;
      thinkingBuffer.text = appendThinking(thinkingBuffer.text, event.message);
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    if (canonical.kind === "message" && canonical.phase === "delta") {
      flushThinking();
      if (!answerBuffer) {
        answerBuffer = {
          id: nextGroupId("answer"),
          createdAt: event.createdAt,
          lastCreatedAt: event.createdAt,
          lastEventId: event.id,
          text: ""
        };
      }
      answerBuffer.lastCreatedAt = event.createdAt;
      answerBuffer.lastEventId = event.id;
      answerBuffer.text += deltaTextForBuffer(event, answerBuffer.text);
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    flushThinking();
    flushAnswer();
    const last = assistantGroups[assistantGroups.length - 1];
    if (
      last &&
      !isLiveDeltaGroup(last) &&
      last.text === event.message &&
      canonical.kind === "message" &&
      canonical.role === "assistant" &&
      canonical.phase === "completed"
    ) {
      boundaryEventId = event.id;
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    if (
      last &&
      !isLiveDeltaGroup(last) &&
      !last.thinking &&
      !last.error &&
      canonical.kind === "message" &&
      canonical.role === "assistant" &&
      canonical.phase === "completed" &&
      isAnswerContinuation(last.text, event.message)
    ) {
      last.text = joinAnswerFragments(last.text, event.message);
      last.lastActivityAt = event.createdAt;
      boundaryEventId = event.id;
      previousEventCreatedAt = event.createdAt;
      continue;
    }
    // A block that lands whole is still live while its turn is: Codex and
    // OpenCode deliver every answer as one completed message, and Claude's
    // completed message replaces the deltas it streamed. Marking it settled
    // here popped the whole block in at once, or cut a reveal short the
    // instant the completion arrived.
    assistantGroups.push({
      id: nextGroupId("answer"),
      createdAt: event.createdAt,
      lastActivityAt: event.createdAt,
      text: event.message,
      streaming
    });
    boundaryEventId = event.id;
    previousEventCreatedAt = event.createdAt;
  }
  flushThinking();
  flushAnswer();
  // Only the newest group is still live. Events arrive in ascending time order,
  // so every earlier group was closed by a tool call, a thinking switch, or an
  // error: its buffer was nulled and the next group took a new boundary-keyed
  // id, so nothing can ever append to it again. Leaving them marked `streaming`
  // made each one eligible for the typewriter, and a group that first mounts
  // with no recorded reveal progress starts at zero characters — so reopening a
  // running session retyped every block of the turn at once. `growing` stays as
  // it was: its only reader defers parsing a plan out of a block, and deferring
  // is the safe side of that call.
  for (let index = 0; index < assistantGroups.length - 1; index += 1) {
    assistantGroups[index].streaming = false;
  }
  return assistantGroups;
}

export function assistantGroupHasVisibleChat(group: Pick<AssistantGroup, "text" | "error" | "thinking">): boolean {
  if (group.thinking) return group.text.trim().length > 0;
  if (group.error) return parseLogDump(group.text).length > 0;
  return splitLogSegments(group.text).length > 0;
}

/**
 * Does the newest turn's own Thought block carry the live progress cue?
 *
 * Reasoning reaches the renderer as a `message.delta` carrying `thinking: true`,
 * so it can be the newest event through a long silent stretch without any
 * visible answer text arriving. Before a turn produces an answer, that
 * reasoning renders expanded and labelled "Thinking" and is the progress cue.
 * Once an answer lands the block settles into quiet "Thought" history, and in
 * single-line verbosity it is dropped from the turn entirely, so it stops being
 * a cue and the generic indicator has to take the beat over.
 *
 * `SessionConversation` reads this to decide whether to show that generic
 * indicator and `SessionConversationTurn` reads it to decide whether to render
 * the block as live. One definition, so the two can never both claim the beat
 * or both leave it empty — the second of which left a running turn with no
 * visible progress at all for as long as the model kept reasoning.
 */
export function liveThoughtOwnsProgress(params: {
  assistantEvents: readonly TimelineEvent[];
  isLatestTurn: boolean;
  sessionRunning: boolean;
  isPausedOnUserInput: boolean;
}): boolean {
  if (!params.isLatestTurn || !params.sessionRunning || params.isPausedOnUserInput) return false;
  let hasThinkingText = false;
  for (const event of params.assistantEvents) {
    if (event.message.trim().length === 0) continue;
    // Any visible answer text in the turn hands the beat back to the generic
    // indicator, whichever order the events arrived in.
    const canonical = decodeTimelineEvent(event);
    if (canonical.kind !== "message" || canonical.content !== "thinking") return false;
    hasThinkingText = true;
  }
  return hasThinkingText;
}

/**
 * Which Thought block carries the live beat, once `liveThoughtOwnsProgress` has
 * said the turn's reasoning owns it at all.
 *
 * Reasoning is flushed into a fresh group at every tool boundary, so a turn that
 * thinks between calls holds one group per burst — a model that never narrates
 * accumulates hundreds of them. Read as a turn-wide flag, `live` opened every
 * one of those at once: replaying one Gemini-through-Cursor session put 114k
 * characters of reasoning on screen across 131 expanded blocks. Only the newest
 * burst is what the reader is waiting on; the ones behind it are history and
 * fold to their `Thought 12s` headers like any settled block.
 */
export function lastThinkingGroupId(groups: readonly AssistantGroup[]): string | null {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.thinking) return group.id;
  }
  return null;
}

function toolStartTimes(toolItems: readonly TurnToolItem[]): string[] {
  return toolItems.map((item) => item.tool.createdAt).sort();
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
    const startedAt = Date.parse(tItem.tool.createdAt);
    if (Number.isFinite(startedAt)) earliest = Math.min(earliest, startedAt);
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
  const visibleAssistantGroups = (cardCutoff
    ? assistantGroups.filter((g) => g.createdAt < cardCutoff)
    : assistantGroups
  ).filter(assistantGroupHasVisibleChat);
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
