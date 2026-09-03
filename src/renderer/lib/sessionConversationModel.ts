import type { EventType, TimelineEvent } from "../../shared/types.js";
import { stringValue } from "../../shared/typeGuards.js";
import { isInternalAgentLaunchMetadata } from "./agentLaunch.js";
import { COMPACTION_FINISHED, COMPACTION_STARTED } from "./compaction.js";
import { MULTITASK_FINISHED, MULTITASK_LAUNCHED } from "./multitask.js";
import { SESSION_MOVED } from "./projectMove.js";
import { PROVIDER_CHANGED } from "./providerSwitch.js";
import {
  cleanToolInput,
  detectToolError,
  extractCompletionCorrelationId,
  extractProviderInvocationId,
  extractToolError,
  extractToolInput,
  extractToolInputPreview,
  extractToolName,
  extractToolOutput,
  extractToolUseId,
  getToolTypeBucket,
  isHiddenToolName,
  type ToolCall
} from "./toolCalls.js";
import {
  advanceTurnBoundary,
  isSubAgentProseEcho,
  isSupersededAnswerDelta,
  type TurnBoundary
} from "./turnBoundaries.js";

function isConversationEventType(type: string): boolean {
  return (
    type === "user.message" ||
    type === "message.delta" ||
    type === "message.completed" ||
    type === "error" ||
    type === COMPACTION_STARTED ||
    type === COMPACTION_FINISHED ||
    type === SESSION_MOVED ||
    type === PROVIDER_CHANGED ||
    type === MULTITASK_LAUNCHED ||
    type === MULTITASK_FINISHED
  );
}

function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

function isConversationVisible(event: TimelineEvent): boolean {
  return (
    event.payload.raw !== true &&
    !isPayloadTruncationMarker(event) &&
    !isSubAgentProseEcho(event) &&
    isConversationEventType(event.type) &&
    event.message !== "turn.completed"
  );
}

function isToolBoundaryEvent(event: TimelineEvent): boolean {
  return event.type === "command.started";
}

function isSupersededTraceEvent(event: TimelineEvent): boolean {
  return event.payload.traceSyntheticSuperseded === true;
}

/** Persisted row order when both rows carry a cursor, wall-clock otherwise. */
function compareEventOrder(left: TimelineEvent, right: TimelineEvent): number {
  if (left.rowCursor !== undefined && right.rowCursor !== undefined && left.rowCursor !== right.rowCursor) {
    return left.rowCursor - right.rowCursor;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function eventIsAfter(left: TimelineEvent, right: TimelineEvent): boolean {
  return compareEventOrder(left, right) > 0;
}

export const SESSION_CLEARED: EventType = "session.cleared";

/**
 * Events after the latest `/clear`. The chat surface and the next prompt both
 * treat everything at or before that watermark as gone. The debug log still
 * reads the full timeline.
 */
export function eventsAfterLatestClear(events: readonly TimelineEvent[]): TimelineEvent[] {
  const clear = latestClearEvent(events);
  if (!clear) return [...events];
  return events.filter((event) => eventIsAfter(event, clear));
}

export function latestClearEvent(events: readonly TimelineEvent[]): TimelineEvent | null {
  let latest: TimelineEvent | null = null;
  for (const event of events) {
    if (event.type !== SESSION_CLEARED) continue;
    if (latest === null || compareEventOrder(event, latest) > 0) {
      latest = event;
    }
  }
  return latest;
}

export function outputsAfterClear<T extends { createdAt: string }>(
  outputs: readonly T[],
  clear: TimelineEvent | null
): T[] {
  if (!clear) return [...outputs];
  return outputs.filter((output) => output.createdAt > clear.createdAt);
}

/** Snapshot events arrive newest-first; reverse before the stable sort so rows
 *  sharing a timestamp keep their persisted order. */
function oldestFirst(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].reverse().sort(compareEventOrder);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function receiverThreadIds(tool: ToolCall): string[] {
  return [
    ...stringArray(tool.inputFull.receiver_thread_ids),
    ...stringArray(tool.inputFull.receiverThreadIds)
  ];
}

function hasReceiverOverlap(left: ToolCall, right: ToolCall): boolean {
  const leftIds = new Set(receiverThreadIds(left));
  if (leftIds.size === 0) return false;
  return receiverThreadIds(right).some((id) => leftIds.has(id));
}

function isCodexSpawnAgentTool(tool: ToolCall): boolean {
  return tool.name.toLowerCase() === "spawn_agent";
}

function hasReceiverThreads(tool: ToolCall): boolean {
  return receiverThreadIds(tool).length > 0;
}

function normalizedAgentLaunchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function agentLaunchPrompt(tool: ToolCall): string | null {
  return (
    stringValue(tool.inputFull.prompt) ??
    stringValue(tool.inputFull.instructions) ??
    stringValue(tool.inputFull.description) ??
    stringValue(tool.inputFull.subagent_type) ??
    stringValue(tool.inputFull.subagentType) ??
    stringValue(tool.inputPreview)
  );
}

function agentLaunchSignature(tool: ToolCall): string | null {
  if (getToolTypeBucket(tool.name) !== "agent") return null;
  const prompt = agentLaunchPrompt(tool);
  if (prompt === null) return null;
  return `${tool.name.toLowerCase()}:${normalizedAgentLaunchText(prompt)}`;
}

function isNoOpCodexAgentLaunch(tool: ToolCall): boolean {
  if (!isCodexSpawnAgentTool(tool)) return false;
  const prompt = agentLaunchPrompt(tool);
  if (prompt === null) return false;
  const normalized = normalizedAgentLaunchText(prompt);
  return (
    /\b(ignore|disregard)\b/.test(normalized) &&
    /\bduplicate\b/.test(normalized) &&
    /\bno action (needed|required)\b/.test(normalized)
  );
}

function hasAgentLaunchLinkage(tool: ToolCall): boolean {
  if (hasReceiverThreads(tool)) return true;
  return stringValue(tool.inputFull.agentId) !== null ||
    stringValue(tool.inputFull.agent_id) !== null ||
    stringValue(tool.inputFull.providerChildSessionId) !== null;
}

function hasRealToolCompletion(tool: ToolCall): boolean {
  return tool.completedAt !== null && tool.completedAt !== tool.createdAt;
}

function hasAgentLaunchEvidence(tool: ToolCall): boolean {
  return hasAgentLaunchLinkage(tool) || tool.output !== null || hasRealToolCompletion(tool);
}

// Providers can emit a launch-looking agent row before the real child link
// exists, then retry with the same prompt once the child is actually created.
// Hide only a terminal earlier row that produced no linkage, output, or real
// completion. A still-running row may be a legitimate parallel same-prompt
// agent, and hiding it would also force-close its open activity pane.
// Unpaired starts with no command.completed are protocol phantoms, not Failed
// agents. A launch that completed with a provider error has evidence and stays.
// Two completed same-prompt agents are legitimate separate work and must stay.
function isSupersededAgentLaunchAttempt(tool: ToolCall, allTools: readonly ToolCall[]): boolean {
  if (getToolTypeBucket(tool.name) !== "agent" || tool.status === "running" || hasAgentLaunchEvidence(tool)) {
    return false;
  }
  const signature = agentLaunchSignature(tool);
  if (signature === null) return false;
  return allTools.some((candidate) =>
    candidate !== tool &&
    candidate.createdAt > tool.createdAt &&
    agentLaunchSignature(candidate) === signature &&
    hasAgentLaunchEvidence(candidate)
  );
}

// Codex's multi-agent transport: the parent blocking on, messaging, or closing
// a child thread. None of it names work the user asked for, and its only input
// is internal thread ids, so it never renders as its own row. Require the
// thread plumbing so an unrelated MCP tool that happens to be called `wait`
// still shows.
function isCodexAgentControlTool(tool: ToolCall): boolean {
  const lower = tool.name.toLowerCase();
  if (lower !== "wait" && lower !== "close_agent" && lower !== "send_message_to_thread") {
    return false;
  }
  return (
    stringValue(tool.inputFull.sender_thread_id) !== null ||
    stringValue(tool.inputFull.senderThreadId) !== null ||
    tool.inputFull.receiver_thread_ids !== undefined ||
    tool.inputFull.receiverThreadIds !== undefined
  );
}

function hasMatchingCodexSender(spawn: ToolCall, control: ToolCall): boolean {
  const spawnSender = stringValue(spawn.inputFull.sender_thread_id) ?? stringValue(spawn.inputFull.senderThreadId);
  const controlSender = stringValue(control.inputFull.sender_thread_id) ?? stringValue(control.inputFull.senderThreadId);
  return spawnSender !== null && spawnSender === controlSender;
}

function codexSpawnCandidates(spawns: readonly ToolCall[], control: ToolCall): ToolCall[] {
  return spawns.filter((spawn) => control.createdAt >= spawn.createdAt);
}

function matchingCodexSpawns(spawns: readonly ToolCall[], control: ToolCall): ToolCall[] {
  const candidates = codexSpawnCandidates(spawns, control);
  if (receiverThreadIds(control).length > 0) {
    const receiverMatches = candidates.filter((spawn) => hasReceiverOverlap(spawn, control));
    if (receiverMatches.length > 0) return receiverMatches;
  } else if (control.name.toLowerCase() === "wait" && control.status !== "running") {
    // A completed wait with no returned receiver ids is a timeout. Its start
    // may have targeted several children, but it did not complete any of them.
    return [];
  }
  const senderMatches = candidates.filter((spawn) => hasMatchingCodexSender(spawn, control));
  return senderMatches.length === 1 ? senderMatches : [];
}

function mergeCodexWaitIntoSpawn(spawn: ToolCall, wait: ToolCall): ToolCall {
  const waitIsAuthoritative = wait.status === "running" || wait.status === "error" || wait.completedAt !== null;
  if (!waitIsAuthoritative) return spawn;
  const status = wait.status;
  return {
    ...spawn,
    inputFull: {
      ...spawn.inputFull,
      ...Object.fromEntries(
        Object.entries(wait.inputFull).filter(([key, value]) => {
          if (key === "prompt") return false;
          // A spawn's `item.started` carries `receiver_thread_ids: []`; the
          // real ids may only exist on the wait row, so an empty array must
          // not block the backfill.
          const spawnValue = spawn.inputFull[key];
          if (spawnValue !== undefined && !(Array.isArray(spawnValue) && spawnValue.length === 0)) {
            return false;
          }
          return value !== null && value !== undefined;
        })
      )
    },
    output: wait.output ?? spawn.output,
    status,
    completedAt: status === "running" ? null : wait.completedAt ?? spawn.completedAt,
    error: wait.error ?? spawn.error
  };
}

// Control rows always disappear. Whether one can be matched to a spawn decides
// only whether its outcome settles that spawn, never whether the transport is
// worth showing: a launch Codex omitted from stdout used to leave the bare
// `wait` behind as the turn's only visible activity.
function foldCodexAgentControlTools(tools: readonly ToolCall[]): ToolCall[] {
  const controls = tools.filter(isCodexAgentControlTool);
  if (controls.length === 0) return [...tools];

  const spawns = tools.filter(isCodexSpawnAgentTool);
  const replacements = new Map<string, ToolCall>();
  for (const control of controls) {
    if (control.name.toLowerCase() !== "wait") continue;
    for (const spawn of matchingCodexSpawns(spawns, control)) {
      const current = replacements.get(spawn.id) ?? spawn;
      replacements.set(spawn.id, mergeCodexWaitIntoSpawn(current, control));
    }
  }
  return tools
    .filter((tool) => !isCodexAgentControlTool(tool))
    .map((tool) => replacements.get(tool.id) ?? tool);
}

function isStillRunningAgentLaunch(
  name: string,
  input: Record<string, unknown>,
  output: string | null,
  completion: TimelineEvent | null
): boolean {
  if (getToolTypeBucket(name) !== "agent") return false;
  if (!completion || detectToolError(completion.payload)) return false;
  // A trace-synthesized completion represents the child lifecycle itself,
  // unlike Codex's normal spawn completion, which only says the child started.
  if (completion.payload.traceSyntheticLaunch === true) return false;
  if (name.toLowerCase() === "spawn_agent") return true;
  const status = stringValue(completion.payload.status);
  if (status === "in_progress" || status === "running" || status === "started") return true;
  if (output && isInternalAgentLaunchMetadata(output)) return true;
  const runInBackground = input.run_in_background ?? input.runInBackground;
  if (runInBackground === true || runInBackground === "true") return true;
  return false;
}

/**
 * Normalize provider timeline events into oldest-first conversation events.
 * Dashboard events arrive newest-first; duplicate streaming deltas are dropped
 * once the completed answer for the same turn has arrived. A tool start between
 * a delta and that completion keeps the delta: providers like Cursor emit real
 * pre-tool narration before the final answer.
 */
export function buildConversationEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const ascending = events
    .filter(
      (event) =>
        !isSupersededTraceEvent(event) &&
        (isConversationVisible(event) || isToolBoundaryEvent(event))
    )
    .reverse();
  // Right-to-left sweep tracking each session's next turn boundary — the same
  // rule the dashboard merge applies when pruning (see turnBoundaries.ts).
  const nextBoundary = new Map<string, TurnBoundary>();
  const visibleIds = new Set<string>();
  for (let index = ascending.length - 1; index >= 0; index -= 1) {
    const event = ascending[index];
    if (!event) continue;
    if (event.type === "message.delta") {
      if (!isSupersededAnswerDelta(event, nextBoundary.get(event.sessionId))) {
        visibleIds.add(event.id);
      }
      continue;
    }
    const boundary = advanceTurnBoundary(nextBoundary.get(event.sessionId), event);
    if (boundary !== undefined) {
      nextBoundary.set(event.sessionId, boundary);
    }
    if (!isToolBoundaryEvent(event)) {
      visibleIds.add(event.id);
    }
  }
  return ascending.filter((event) => visibleIds.has(event.id));
}

export function hasRenderableSessionContent(
  conversationEvents: readonly TimelineEvent[],
  events: readonly TimelineEvent[]
): boolean {
  return (
    conversationEvents.some((event) => event.type !== "user.message") ||
    events.some((event) => event.type === "command.started" || event.type === "session.streaming")
  );
}

type StartedTool = {
  event: TimelineEvent;
  toolUseId: string;
  invocationId: string | null;
  completion: TimelineEvent | null;
};

/**
 * The latest still-unpaired start a completion can belong to. Invocation
 * identity is all-or-nothing: stamped rows pair only within their invocation,
 * while historical rows pair only with other unstamped rows.
 */
function findJoinIndex(pending: readonly StartedTool[], invocationId: string | null): number {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const candidate = pending[index];
    if (!candidate) continue;
    if (candidate.invocationId === invocationId) {
      return index;
    }
  }
  return -1;
}

/**
 * Join `command.started` to `command.completed` in one oldest-first sweep.
 * Each completion consumes its start, so two invocations that reuse a
 * provider-native id stay two tools instead of collapsing into whichever row
 * happened to be written last.
 */
function correlateToolEvents(events: readonly TimelineEvent[]): StartedTool[] {
  const started: StartedTool[] = [];
  const pendingByToolUseId = new Map<string, StartedTool[]>();
  for (const event of oldestFirst(events)) {
    if (isSupersededTraceEvent(event)) continue;
    if (event.type === "command.started") {
      const toolUseId = extractToolUseId(event.payload) ?? event.id;
      const start: StartedTool = {
        event,
        toolUseId,
        invocationId: extractProviderInvocationId(event.payload),
        completion: null
      };
      started.push(start);
      const pending = pendingByToolUseId.get(toolUseId);
      if (pending) pending.push(start);
      else pendingByToolUseId.set(toolUseId, [start]);
      continue;
    }
    if (event.type !== "command.completed") continue;
    const toolUseId = extractCompletionCorrelationId(event.payload);
    if (!toolUseId) continue;
    const pending = pendingByToolUseId.get(toolUseId);
    if (!pending) continue;
    const index = findJoinIndex(pending, extractProviderInvocationId(event.payload));
    if (index === -1) continue;
    const [match] = pending.splice(index, 1);
    if (match) match.completion = event;
  }
  return started;
}

export function buildSessionToolCalls(
  events: readonly TimelineEvent[],
  sessionRunning = true
): ToolCall[] {
  const visibleProgressEvents = events.filter(isConversationVisible);
  const tools = correlateToolEvents(events)
    .filter(({ event }) => {
      const rawName = stringValue(event.payload.name);
      return rawName === null || !isHiddenToolName(rawName);
    })
    .map(({ event, toolUseId, completion }) => {
      const providerName = stringValue(event.payload.name);
      const name = extractToolName(event.payload);
      const startInput = extractToolInput(event.payload);
      const completionInput = completion ? extractToolInput(completion.payload) : {};
      const mergedInput = Object.keys(completionInput).length > 0
        ? { ...startInput, ...completionInput }
        : startInput;
      const input = cleanToolInput(name, mergedInput, providerName);
      const output = completion ? extractToolOutput(completion.payload) : null;
      const isError = completion ? detectToolError(completion.payload) : false;
      const hasLaterVisibleProgress = visibleProgressEvents.some((progress) => eventIsAfter(progress, event));
      // A started tool with no matching `command.completed` is normally still
      // running — but a completion can be lost. An image `Read`'s tool_result
      // embeds a base64 blob that overflows the normalizer's per-line parse cap
      // (providers/normalizer/mod.rs JSON_PARSE_LINE_CAP), so the whole line —
      // and the `command.completed` it carried — is dropped, even though the
      // tool finished upstream. A later visible user/assistant/error event means
      // the turn has moved past that tool; without that, only a stopped session
      // can prove the unpaired tool is no longer in flight. Agent tools are the
      // exception: the parent model can narrate while a spawned agent is still
      // working, so keep them running until their own completion arrives.
      const isAgent = getToolTypeBucket(name) === "agent";
      const inferredDone =
        !sessionRunning || (!isAgent && hasLaterVisibleProgress);
      const status: ToolCall["status"] = completion
        ? isError
          ? "error"
          : "done"
        : inferredDone
          ? "done"
          : "running";
      const renderedStatus: ToolCall["status"] =
        status === "done" && sessionRunning && isStillRunningAgentLaunch(name, input, output, completion)
          ? "running"
          : status;
      const rawParent = event.payload.parent_tool_use_id;
      const parentToolUseId = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : null;
      return {
        id: event.id,
        toolUseId,
        name,
        inputPreview: extractToolInputPreview(name, input),
        inputFull: input,
        output,
        status: renderedStatus,
        createdAt: event.createdAt,
        // No real completion timestamp exists for a dropped completion; anchor
        // the inferred-done case at the start so the chip shows a check instead
        // of a stale, ever-climbing timer.
        completedAt: renderedStatus === "running"
          ? null
          : completion
            ? completion.createdAt
            : status === "done"
              ? event.createdAt
              : null,
        error: completion && isError ? extractToolError(completion.payload) : null,
        parentToolUseId
      };
    });
  const folded = foldCodexAgentControlTools(tools);
  return folded.filter(
    (tool) =>
      !isHiddenToolName(tool.name) &&
      !isNoOpCodexAgentLaunch(tool) &&
      !isSupersededAgentLaunchAttempt(tool, folded)
  );
}

/**
 * Tool-use ids of rows that live inside a launched subagent. The parent chat
 * folds these under the launch row instead of rendering them, so parent-level
 * progress state must not react to them.
 */
export function subAgentToolUseIds(tools: readonly ToolCall[]): Set<string> {
  return new Set(
    tools.filter((tool) => tool.parentToolUseId !== null).map((tool) => tool.toolUseId)
  );
}

/**
 * A tool boundary that belongs to a subagent, not to the parent turn. Child
 * `command.started` rows carry `parent_tool_use_id`; their `command.completed`
 * often does not, so the id set from `subAgentToolUseIds` carries the linkage.
 */
function isSubAgentToolEvent(event: TimelineEvent, childToolUseIds: ReadonlySet<string>): boolean {
  if (event.type !== "command.started" && event.type !== "command.completed") return false;
  const rawParent = event.payload.parent_tool_use_id;
  if (typeof rawParent === "string" && rawParent.length > 0) return true;
  const toolUseId = event.type === "command.started"
    ? extractToolUseId(event.payload)
    : extractCompletionCorrelationId(event.payload);
  return typeof toolUseId === "string" && toolUseId.length > 0 && childToolUseIds.has(toolUseId);
}

/** Rows the parent chat renders itself: not raw, not a truncation marker, not
 *  a subagent row folded under its launch row. */
function isParentVisibleEvent(
  event: TimelineEvent,
  childToolUseIds: ReadonlySet<string>
): boolean {
  return (
    event.payload.raw !== true &&
    !isPayloadTruncationMarker(event) &&
    !isSubAgentProseEcho(event) &&
    !isSubAgentToolEvent(event, childToolUseIds) &&
    event.message !== "turn.completed"
  );
}

export function lastSignificantSessionEvent(
  events: readonly TimelineEvent[],
  childToolUseIds: ReadonlySet<string> = new Set<string>()
): TimelineEvent | undefined {
  return events.find(
    (event) =>
      isParentVisibleEvent(event, childToolUseIds) &&
      (event.type === "user.message" ||
        event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.started" ||
        event.type === "command.completed")
  );
}

/**
 * Newest event where the agent itself spoke: parent-visible output, a tool
 * boundary, or a failure. Same filters as `lastSignificantSessionEvent` minus
 * `user.message`, so its id is a stable "has the provider taken over yet?"
 * marker for a turn the renderer just started locally.
 */
export function lastAgentResponseEvent(
  events: readonly TimelineEvent[],
  childToolUseIds: ReadonlySet<string> = new Set<string>()
): TimelineEvent | undefined {
  return events.find(
    (event) =>
      isParentVisibleEvent(event, childToolUseIds) &&
      (event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.started" ||
        event.type === "command.completed" ||
        event.type === "error")
  );
}
