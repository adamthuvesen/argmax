import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import type { RenderItem } from "./foldConversation.js";
import {
  isNoisyPlainProviderLine,
  isNoisyProviderTracing,
  matchTracingRecord,
  parseLogDump,
  splitLogSegments
} from "./logDump.js";
import {
  collectAskUserQuestionState,
  type ResolvedAskUserQuestionTool
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

/** A remark about the work runs to about three sentences; past that it is writing. */
const NARRATION_MAX_CHARS = 400;

/**
 * Is this prose a passing remark about the work, or writing meant to be read?
 *
 * "Let me check the docs." and "First part done." are remarks: one short
 * paragraph of plain sentences. Anything that carries structure — a heading, a
 * list, a table, a code fence, a quote — or runs past a few sentences or a
 * blank line is the answer itself, whatever tool call happens to follow it.
 */
export function isProgressNarration(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > NARRATION_MAX_CHARS) return false;
  if (/\n\s*\n/.test(trimmed)) return false;
  return !/^ {0,3}(#{1,6} |[-*+] |\d+[.)] |> |\||```|~~~)/m.test(trimmed);
}

/** Past this, prose after the turn's last tool is an answer, not a sign-off. */
const CLOSING_REMARK_MAX_CHARS = 160;

/**
 * Does the prose after the turn's last tool read as an acknowledgement of that
 * tool rather than as the turn's answer?
 *
 * Both halves are load-bearing and both are deliberately strict, because the
 * cost of guessing wrong in this direction is showing narration the reader
 * asked to hide, while the cost of guessing wrong in the other is losing the
 * answer entirely. A real turn that narrates, works, and then answers —
 * "Chronicle isn't available, so I'll fall back to the repository." → `Bash` →
 * "The last two published runs both landed at 9/10." — has a tail of 48
 * against 78, nowhere near half, and folds as it always did.
 */
function isClosingRemark(candidateLength: number, tailLength: number): boolean {
  if (tailLength === 0 || tailLength >= CLOSING_REMARK_MAX_CHARS) return false;
  return tailLength * 2 < candidateLength;
}

/**
 * Minimal verbosity, finished and collapsed: the prose Claude, Codex, Grok,
 * and OpenCode write before each tool is progress, not the answer, so it hides
 * with the tools it narrates. Returns the group ids to drop.
 *
 * Two groups are always kept, and between them they are what "the answer"
 * means here:
 *
 * - **The last prose group**, so collapsing can never leave the chip standing
 *   over nothing.
 * - **The prose before the last tool, when what follows that tool is only a
 *   sign-off.** Shape alone cannot tell a one-line answer from a one-line
 *   remark — "No, that file does not exist." and "Reading the repo now." are
 *   the same object to any predicate, and nothing in the event stream marks
 *   which is which. What does separate them is the tail: an agent that
 *   answers, records the answer with one closing edit or memory write, and
 *   signs off ("Done.") leaves a tail far shorter than the answer it
 *   acknowledges. `isClosingRemark` draws that line deliberately tight —
 *   a turn whose post-tool prose is half the writing of its pre-tool prose is
 *   a turn that narrated and then answered, and it folds as before.
 *
 * Everything else at or before the last tool hides, provided it reads as a
 * remark: `isProgressNarration` keeps a second block of real writing — a turn
 * that writes section one, edits, writes section two — out of the fold.
 *
 * A surface that renders the answer itself (the agent pane's result panel)
 * passes `separateAnswer`: there the answer has its own home, so everything
 * left in the turn really is work and all of it hides, longest included.
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
  const prose = groups.filter((group) => !group.thinking && !group.error);
  const kept = new Set<string>();
  if (!options.separateAnswer) {
    const last = prose[prose.length - 1];
    if (last) kept.add(last.id);
    const beforeLastTool = prose.filter((group) => group.lastActivityAt <= lastToolCreatedAt);
    const candidate = beforeLastTool[beforeLastTool.length - 1];
    const tail = prose
      .filter((group) => group.lastActivityAt > lastToolCreatedAt)
      .reduce((total, group) => total + group.text.trim().length, 0);
    if (candidate && isClosingRemark(candidate.text.trim().length, tail)) kept.add(candidate.id);
  }
  for (const group of prose) {
    if (kept.has(group.id)) continue;
    if (!options.separateAnswer && !isProgressNarration(group.text)) continue;
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
 *
 * A reasoning burst ends where the provider stops thinking and starts working;
 * the next burst arrives as another delta with nothing marking the seam. Two
 * seams are visible:
 *
 * - Grok ends a burst on a full stop with no trailing space, so raw
 *   concatenation reads "make a todo list firstThe files don't exist".
 * - Codex sends each reasoning summary as its own `**Header**` fragment. Glued
 *   end to end the delimiters collapse into `****` and markdown renders the
 *   titles as one run-on line ("debuggingInspecting", or a leftover `****`).
 *
 * Those breaks are only inserted at those exact seams — a token stream never
 * produces them on its own. Whitespace on either side already separates the
 * two, so a normal stream is left byte for byte as it arrived.
 */
function appendThinking(current: string, incoming: string, payload: TimelineEvent["payload"]): string {
  // Older Codex streams lost summary-part separators, then replayed the whole
  // item. Match that saved suffix even after live fragments already gained
  // paragraph breaks, and restore the completed item's own spacing.
  const summary = payload.summary;
  if (payload.type === "reasoning" && payload.providerEventType === "item.completed" &&
      Array.isArray(summary) && summary.every((part): part is string => typeof part === "string") &&
      incoming === summary.join("\n")) {
    const streamed = summary.join("");
    for (const suffix of [streamed, incoming]) {
      const prefix = dropTrailingThought(current, suffix);
      if (prefix !== null) return joinThoughtParagraphs(prefix, incoming);
    }
  }
  if (incoming.startsWith(current)) {
    return splitCollapsedThoughtTitles(current + incoming.slice(current.length));
  }
  if (current.endsWith(incoming)) return current;
  if (isBurstSeam(current, incoming)) return joinThoughtParagraphs(current, incoming);
  return splitCollapsedThoughtTitles(current + incoming);
}

function isBurstSeam(current: string, incoming: string): boolean {
  if (current.length === 0 || incoming.length === 0) return false;
  if (/\s$/.test(current) || /^\s/.test(incoming)) return false;
  if (current.endsWith("**") && incoming.startsWith("**")) return true;
  if (!".!?…".includes(current.charAt(current.length - 1))) return false;
  const first = incoming.charAt(0);
  return first !== first.toLowerCase();
}

function joinThoughtParagraphs(current: string, incoming: string): string {
  if (current.length === 0) return splitCollapsedThoughtTitles(incoming);
  if (current.endsWith("\n\n")) return splitCollapsedThoughtTitles(current + incoming);
  if (current.endsWith("\n")) return splitCollapsedThoughtTitles(`${current}\n${incoming}`);
  return splitCollapsedThoughtTitles(`${current}\n\n${incoming}`);
}

/** `**A****B**` is two Codex titles, not four asterisks of prose. */
function splitCollapsedThoughtTitles(text: string): string {
  return text.replaceAll("****", "**\n\n**");
}

/**
 * How much of `current` to keep if it already ends with `suffix`, ignoring
 * whitespace either side inserted as paragraph breaks. Null when it does not.
 */
function dropTrailingThought(current: string, suffix: string): string | null {
  const compact = suffix.replace(/\s+/g, "");
  if (compact.length === 0) return null;
  let i = current.length;
  let j = compact.length;
  while (i > 0 && j > 0) {
    const ch = current.charAt(i - 1);
    if (/\s/.test(ch)) {
      i -= 1;
      continue;
    }
    j -= 1;
    if (ch !== compact.charAt(j)) return null;
    i -= 1;
  }
  return j > 0 ? null : current.slice(0, i);
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
  return start !== start.toUpperCase() && start === start.toLowerCase();
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
  options: {
    hardSplitAt?: readonly string[];
    splitAt?: readonly string[];
    streaming?: boolean;
  } = {}
): AssistantGroup[] {
  const assistantGroups: AssistantGroup[] = [];
  type Buffer = { id: string; createdAt: string; lastCreatedAt: string; lastEventId: string; text: string };
  let answerBuffer: Buffer | null = null;
  let thinkingBuffer: Buffer | null = null;
  let previousEventCreatedAt: string | null = null;
  const hardSplitAt = options.hardSplitAt ?? [];
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
  const hardSplitBefore = (event: TimelineEvent): boolean => {
    const previous = previousEventCreatedAt;
    return (
      previous !== null &&
      hardSplitAt.some((time) => time > previous && time <= event.createdAt)
    );
  };
  const pushErrorLine = (
    event: TimelineEvent,
    message: string,
    canJoinPrevious = true
  ): void => {
    const last = assistantGroups[assistantGroups.length - 1];
    if (canJoinPrevious && last?.error) {
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
    const startsAfterHardBoundary = hardSplitBefore(event);
    if (startsAfterHardBoundary || splitBefore(event)) {
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
      if (
        (tracing && isNoisyProviderTracing(tracing.target, tracing.message)) ||
        (!tracing && canonical.kind === "error" && isNoisyPlainProviderLine(event.message))
      ) {
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
      pushErrorLine(event, message, !startsAfterHardBoundary);
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
        if (message.length > 0) pushErrorLine(event, message, !startsAfterHardBoundary);
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
      thinkingBuffer.text = appendThinking(thinkingBuffer.text, event.message, event.payload);
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
      !startsAfterHardBoundary &&
      !isLiveDeltaGroup(last) &&
      !last.thinking &&
      !last.error &&
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
      !startsAfterHardBoundary &&
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
 * visible answer text arriving. While it is the newest thing the turn has
 * produced, that reasoning renders labelled "Thinking" (and, at Steps, as a
 * live preview) and is the progress cue. Anything after it — answer text, or a
 * tool that started once it was written — makes it quiet "Thought" history,
 * and the generic indicator or the tool line takes the beat over.
 *
 * Narration *earlier* in the turn no longer disqualifies it. That rule kept
 * every thought after "I'll look at the code…" from ever reading as live, and
 * Claude, Cursor and Grok narrate before almost every burst. Grok alternates
 * tiny thinking/text pairs, so its cue moves between the two; each move is a
 * real change of state.
 *
 * `SessionConversation` reads this to decide whether to show that generic
 * indicator and `SessionConversationTurn` reads it to decide whether to render
 * the block as live. One definition, so the two can never both claim the beat
 * or both leave it empty — the second of which left a running turn with no
 * visible progress at all for as long as the model kept reasoning.
 */
export function liveThoughtOwnsProgress(params: {
  assistantEvents: readonly TimelineEvent[];
  toolItems: readonly TurnToolItem[];
  isLatestTurn: boolean;
  sessionRunning: boolean;
  isPausedOnUserInput: boolean;
}): boolean {
  if (!params.isLatestTurn || !params.sessionRunning || params.isPausedOnUserInput) return false;
  let newest: TimelineEvent | null = null;
  for (const event of params.assistantEvents) {
    if (event.message.trim().length === 0) continue;
    if (newest === null || event.createdAt >= newest.createdAt) newest = event;
  }
  if (newest === null) return false;
  const canonical = decodeTimelineEvent(newest);
  if (canonical.kind !== "message" || canonical.content !== "thinking") return false;
  // A tool stamped in the same instant came after the reasoning in its
  // envelope, so ties go to the tool.
  const thoughtAt = newest.createdAt;
  return !params.toolItems.some((item) => item.tool.createdAt >= thoughtAt);
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

function computeTurnStartedAtMs(params: {
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

type TurnRenderState = {
  assistantGroups: AssistantGroup[];
  visibleAssistantGroups: AssistantGroup[];
  cardCutoff: string | null;
  askUserQuestionTool: ResolvedAskUserQuestionTool | null;
  askUserQuestionHiddenToolIds: Set<string>;
  hiddenToolIds: Set<string>;
  hasQuestionCard: boolean;
  turnStartedAtMs: number;
  isPausedOnUserInput: boolean;
};

export function buildTurnRenderState(params: {
  assistantEvents: readonly TimelineEvent[];
  assistantHardSplitAt?: readonly string[];
  toolItems: readonly TurnToolItem[];
  priorItem: RenderItem | null;
  assistantTimestamps: readonly number[];
  isStreamingTurn?: boolean;
}): TurnRenderState {
  const assistantGroups = coalesceAssistantGroups(params.assistantEvents, {
    hardSplitAt: params.assistantHardSplitAt,
    splitAt: toolStartTimes(params.toolItems),
    streaming: params.isStreamingTurn ?? true
  });
  const { tool: askUserQuestionTool, hiddenToolIds: askUserQuestionHiddenToolIds } =
    collectAskUserQuestionState(params.toolItems);
  const hasQuestionCard = askUserQuestionTool !== null;
  const hasBlockingQuestion = hasQuestionCard && askUserQuestionTool.delivery !== "async";
  const cardCutoff = hasBlockingQuestion ? askUserQuestionTool.createdAt : null;
  const visibleAssistantGroups = (cardCutoff
    ? assistantGroups.filter((g) => g.createdAt < cardCutoff)
    : assistantGroups
  ).filter(assistantGroupHasVisibleChat);
  const hiddenToolIds = new Set(askUserQuestionHiddenToolIds);

  return {
    assistantGroups,
    visibleAssistantGroups,
    cardCutoff,
    askUserQuestionTool,
    askUserQuestionHiddenToolIds,
    hiddenToolIds,
    hasQuestionCard,
    turnStartedAtMs: computeTurnStartedAtMs({
      priorItem: params.priorItem,
      assistantTimestamps: params.assistantTimestamps,
      toolItems: params.toolItems
    }),
    isPausedOnUserInput: hasBlockingQuestion
  };
}
