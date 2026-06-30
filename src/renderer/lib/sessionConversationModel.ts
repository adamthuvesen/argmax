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
  type ToolCall
} from "./toolCalls.js";

function isConversationEventType(type: string): boolean {
  return type === "user.message" || type === "message.delta" || type === "message.completed" || type === "error";
}

export function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

export function isSubAgentProseEcho(event: TimelineEvent): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed") return false;
  const parentToolUseId = event.payload.parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
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

/**
 * Normalize provider timeline events into oldest-first conversation events.
 * Dashboard events arrive newest-first; duplicate streaming deltas are dropped
 * once the completed answer for the same turn has arrived, except for
 * extended-thinking deltas because no completed event carries that text.
 */
export function buildConversationEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const ascending = events.filter(isConversationVisible).reverse();
  let hasCompletedBeforeNextUser = false;
  const visible: TimelineEvent[] = [];
  for (let index = ascending.length - 1; index >= 0; index -= 1) {
    const event = ascending[index];
    if (!event) continue;
    if (event.type === "user.message") {
      hasCompletedBeforeNextUser = false;
      visible.push(event);
      continue;
    }
    if (event.type === "message.completed") {
      hasCompletedBeforeNextUser = true;
      visible.push(event);
      continue;
    }
    if (event.type !== "message.delta") {
      visible.push(event);
      continue;
    }
    if (event.payload?.["thinking"] === true || !hasCompletedBeforeNextUser) {
      visible.push(event);
    }
  }
  visible.reverse();
  return visible;
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

export function buildSessionToolCalls(events: readonly TimelineEvent[]): ToolCall[] {
  const starts = new Map<string, { event: TimelineEvent; toolUseId: string }>();
  const completions = new Map<string, TimelineEvent>();
  for (const event of events) {
    if (event.type === "command.started") {
      const toolUseId = extractToolUseId(event.payload) ?? event.id;
      starts.set(toolUseId, { event, toolUseId });
    } else if (event.type === "command.completed") {
      const toolUseId = extractCompletionCorrelationId(event.payload);
      if (toolUseId) completions.set(toolUseId, event);
    }
  }
  return [...starts.values()]
    .map(({ event, toolUseId }) => {
      const name = extractToolName(event.payload);
      const completion = completions.get(toolUseId);
      const startInput = extractToolInput(event.payload);
      const completionInput = completion ? extractToolInput(completion.payload) : {};
      const input = Object.keys(startInput).length > 0 ? startInput : completionInput;
      const isError = completion ? detectToolError(completion.payload) : false;
      const status: ToolCall["status"] = !completion ? "running" : isError ? "error" : "done";
      const rawParent = event.payload.parent_tool_use_id;
      const parentToolUseId = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : null;
      return {
        id: event.id,
        toolUseId,
        name,
        inputPreview: extractToolInputPreview(name, input),
        inputFull: input,
        output: completion ? extractToolOutput(completion.payload) : null,
        status,
        createdAt: event.createdAt,
        completedAt: completion ? completion.createdAt : null,
        error: completion && isError ? extractToolError(completion.payload) : null,
        parentToolUseId
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
