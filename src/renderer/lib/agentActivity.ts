import type { TimelineEvent } from "../../shared/types.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import { type ToolCall } from "./toolCalls.js";

export type AgentActivityItem =
  | { kind: "message"; event: TimelineEvent }
  | { kind: "tool"; tool: ToolCall };

export type AgentActivity = {
  parentTool: ToolCall | null;
  title: string;
  prompt: string | null;
  subagentType: string | null;
  status: "running" | "done" | "error" | "missing";
  items: AgentActivityItem[];
  finalOutput: string | null;
  limited: boolean;
  receiverThreadIds: string[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function payloadObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function receiverThreadIdsFromTool(tool: ToolCall | null): string[] {
  if (!tool) return [];
  return [
    ...stringArray(tool.inputFull.receiver_thread_ids),
    ...stringArray(tool.inputFull.receiverThreadIds)
  ];
}

function codexAgentMessageThreadId(event: TimelineEvent): string | null {
  if (event.payload.item_type !== "agent_message") {
    const item = payloadObject(event.payload.item);
    if (item?.type !== "agent_message") return null;
  }
  return stringValue(event.payload.thread_id)
    ?? stringValue(event.payload.sender_thread_id)
    ?? stringValue(payloadObject(event.payload.item)?.thread_id)
    ?? stringValue(payloadObject(event.payload.item)?.sender_thread_id);
}

export function isCodexAgentMessageEvent(event: TimelineEvent): boolean {
  return codexAgentMessageThreadId(event) !== null;
}

function isChildMessage(
  event: TimelineEvent,
  parentToolUseId: string,
  receiverThreadIds: readonly string[]
): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed" && event.type !== "error") {
    return false;
  }
  if (event.payload.parent_tool_use_id === parentToolUseId) return true;
  const threadId = codexAgentMessageThreadId(event);
  return threadId !== null && receiverThreadIds.includes(threadId);
}

function itemTime(item: AgentActivityItem): string {
  return item.kind === "message" ? item.event.createdAt : item.tool.createdAt;
}

function normalizedPromptEcho(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function activityTitle(tool: ToolCall | null, parentToolUseId: string): string {
  if (!tool) return `Agent ${parentToolUseId}`;
  const description = stringValue(tool.inputFull.description);
  if (description) return description;
  const subagentType = stringValue(tool.inputFull.subagent_type) ?? stringValue(tool.inputFull.subagentType);
  if (subagentType) return subagentType;
  if (tool.inputPreview) return tool.inputPreview;
  return "Agent";
}

export function buildAgentActivity(params: {
  parentToolUseId: string;
  events: readonly TimelineEvent[];
  sessionRunning?: boolean;
}): AgentActivity {
  const { parentToolUseId, events, sessionRunning = true } = params;
  const tools = buildSessionToolCalls(events, sessionRunning);
  const parentTool = tools.find((tool) => tool.toolUseId === parentToolUseId) ?? null;
  const receiverThreadIds = receiverThreadIdsFromTool(parentTool);
  const childTools = tools.filter((tool) => tool.parentToolUseId === parentToolUseId);
  const childMessages = events
    .filter((event) => isChildMessage(event, parentToolUseId, receiverThreadIds))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const childToolIds = new Set(childTools.map((tool) => tool.id));
  const prompt = parentTool
    ? stringValue(parentTool.inputFull.prompt) ?? stringValue(parentTool.inputFull.instructions)
    : null;
  const promptEcho = prompt ? normalizedPromptEcho(prompt) : null;
  const visibleChildMessages = promptEcho
    ? childMessages.filter((event) => normalizedPromptEcho(event.message) !== promptEcho)
    : childMessages;
  const items: AgentActivityItem[] = [
    ...visibleChildMessages.map((event) => ({ kind: "message" as const, event })),
    ...childTools.map((tool) => ({ kind: "tool" as const, tool }))
  ].sort((a, b) => {
    const cmp = itemTime(a).localeCompare(itemTime(b));
    if (cmp !== 0) return cmp;
    return (a.kind === "message" ? -1 : 0) - (b.kind === "message" ? -1 : 0);
  });
  const subagentType = parentTool
    ? stringValue(parentTool.inputFull.subagent_type) ?? stringValue(parentTool.inputFull.subagentType)
    : null;
  const status = parentTool?.status ?? "missing";
  return {
    parentTool,
    title: activityTitle(parentTool, parentToolUseId),
    prompt,
    subagentType,
    status,
    items,
    finalOutput: parentTool?.output ?? null,
    limited: parentTool !== null && visibleChildMessages.length === 0 && childToolIds.size === 0,
    receiverThreadIds
  };
}
