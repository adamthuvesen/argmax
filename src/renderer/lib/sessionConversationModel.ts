import type { TimelineEvent } from "../../shared/types.js";
import {
  detectToolError,
  extractCompletionCorrelationId,
  extractToolError,
  extractToolInput,
  extractToolInputPreview,
  extractToolName,
  extractToolOutput,
  extractToolUseId,
  getToolTypeBucket,
  type ToolCall
} from "./toolCalls.js";
import {
  advanceTurnBoundary,
  isSubAgentProseEcho,
  isSupersededAnswerDelta,
  type TurnBoundary
} from "./turnBoundaries.js";

function isConversationEventType(type: string): boolean {
  return type === "user.message" || type === "message.delta" || type === "message.completed" || type === "error";
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

function eventIsAfter(left: TimelineEvent, right: TimelineEvent): boolean {
  if (left.rowCursor !== undefined && right.rowCursor !== undefined && left.rowCursor !== right.rowCursor) {
    return left.rowCursor > right.rowCursor;
  }
  return left.createdAt > right.createdAt;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function agentLaunchSignature(tool: ToolCall): string | null {
  if (getToolTypeBucket(tool.name) !== "agent") return null;
  const prompt =
    stringValue(tool.inputFull.prompt) ??
    stringValue(tool.inputFull.instructions) ??
    stringValue(tool.inputFull.description) ??
    stringValue(tool.inputFull.subagent_type) ??
    stringValue(tool.inputFull.subagentType) ??
    stringValue(tool.inputPreview);
  if (prompt === null) return null;
  return `${tool.name.toLowerCase()}:${normalizedAgentLaunchText(prompt)}`;
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
// Hide only a terminal earlier row that produced no linkage/output/completion;
// a still-running row may be a legitimate parallel same-prompt agent, and
// hiding it would also force-close its open activity pane. Two completed
// same-prompt agents are legitimate separate work and must stay.
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

function isCodexAgentControlTool(tool: ToolCall): boolean {
  const lower = tool.name.toLowerCase();
  return lower === "wait" || lower === "close_agent" || lower === "send_message_to_thread";
}

function matchesCodexSpawnAgent(spawn: ToolCall, control: ToolCall): boolean {
  if (control.createdAt < spawn.createdAt) return false;
  if (hasReceiverOverlap(spawn, control)) return true;
  const spawnSender = stringValue(spawn.inputFull.sender_thread_id) ?? stringValue(spawn.inputFull.senderThreadId);
  const controlSender = stringValue(control.inputFull.sender_thread_id) ?? stringValue(control.inputFull.senderThreadId);
  return spawnSender !== null && spawnSender === controlSender;
}

function findMatchingCodexSpawn(spawns: readonly ToolCall[], control: ToolCall): ToolCall | null {
  const matches = spawns
    .filter((spawn) => matchesCodexSpawnAgent(spawn, control))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0] ?? null;
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

function foldCodexAgentControlTools(tools: readonly ToolCall[]): ToolCall[] {
  const spawns = tools.filter(isCodexSpawnAgentTool);
  if (spawns.length === 0) return [...tools];

  const hiddenIds = new Set<string>();
  const replacements = new Map<string, ToolCall>();
  for (const control of tools) {
    if (!isCodexAgentControlTool(control)) continue;
    const spawn = findMatchingCodexSpawn(spawns, control);
    if (!spawn) continue;
    hiddenIds.add(control.id);
    if (control.name.toLowerCase() === "wait") {
      const current = replacements.get(spawn.id) ?? spawn;
      replacements.set(spawn.id, mergeCodexWaitIntoSpawn(current, control));
    }
  }
  if (hiddenIds.size === 0 && replacements.size === 0) return [...tools];
  return tools
    .filter((tool) => !hiddenIds.has(tool.id))
    .map((tool) => replacements.get(tool.id) ?? tool);
}

function isInProgressCodexSpawn(name: string, completion: TimelineEvent | undefined): boolean {
  if (name.toLowerCase() !== "spawn_agent" || !completion) return false;
  return completion.payload.status === "in_progress";
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
    .filter((event) => isConversationVisible(event) || isToolBoundaryEvent(event))
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

export function buildSessionToolCalls(
  events: readonly TimelineEvent[],
  sessionRunning = true
): ToolCall[] {
  const starts = new Map<string, { event: TimelineEvent; toolUseId: string }>();
  const completions = new Map<string, TimelineEvent>();
  const visibleProgressEvents = events.filter(isConversationVisible);
  for (const event of events) {
    if (event.type === "command.started") {
      const toolUseId = extractToolUseId(event.payload) ?? event.id;
      starts.set(toolUseId, { event, toolUseId });
    } else if (event.type === "command.completed") {
      const toolUseId = extractCompletionCorrelationId(event.payload);
      if (toolUseId) completions.set(toolUseId, event);
    }
  }
  const tools = [...starts.values()]
    .map(({ event, toolUseId }) => {
      const name = extractToolName(event.payload);
      const completion = completions.get(toolUseId);
      const startInput = extractToolInput(event.payload);
      const completionInput = completion ? extractToolInput(completion.payload) : {};
      const input = Object.keys(completionInput).length > 0
        ? { ...startInput, ...completionInput }
        : startInput;
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
      const inferredDone =
        !sessionRunning || (getToolTypeBucket(name) !== "agent" && hasLaterVisibleProgress);
      const status: ToolCall["status"] = completion
        ? isError
          ? "error"
          : "done"
        : inferredDone
          ? "done"
          : "running";
      const renderedStatus: ToolCall["status"] =
        status === "done" && sessionRunning && isInProgressCodexSpawn(name, completion)
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
        output: completion ? extractToolOutput(completion.payload) : null,
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
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const folded = foldCodexAgentControlTools(tools);
  return folded.filter((tool) => !isSupersededAgentLaunchAttempt(tool, folded));
}

export function lastSignificantSessionEvent(events: readonly TimelineEvent[]): TimelineEvent | undefined {
  return events.find(
    (event) =>
      event.payload.raw !== true &&
      !isPayloadTruncationMarker(event) &&
      !isSubAgentProseEcho(event) &&
      event.message !== "turn.completed" &&
      (event.type === "user.message" ||
        event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.started" ||
        event.type === "command.completed")
  );
}
