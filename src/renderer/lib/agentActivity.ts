import { modelLabelForReference, REASONING_EFFORTS } from "../../shared/providerModels.js";
import type { ProviderId, TimelineEvent } from "../../shared/types.js";
import { stringValue } from "../../shared/typeGuards.js";
import { isInternalAgentLaunchMetadata } from "./agentLaunch.js";
import { effortLabel } from "./models.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import { type ToolCall } from "./toolCalls.js";

export type AgentActivityItem =
  | { kind: "message"; event: TimelineEvent }
  | { kind: "tool"; tool: ToolCall };

/** What a subagent ran on, resolved for display. */
export type AgentModel = {
  /** Catalog label when the model is known, the provider's own id otherwise. */
  label: string;
  /** Display-ready effort, or null when the provider never reported one. */
  effort: string | null;
};

export type AgentActivity = {
  parentTool: ToolCall | null;
  title: string;
  prompt: string | null;
  subagentType: string | null;
  model: AgentModel | null;
  status: "running" | "done" | "error" | "missing";
  items: AgentActivityItem[];
  finalOutput: string | null;
  limited: boolean;
  receiverThreadIds: string[];
};

/**
 * Same non-empty test as `stringValue`, but blank-aware: these reads feed the
 * activity header, where a whitespace-only value must lose to the next
 * fallback rather than render as an empty title or an empty prompt block. Id
 * reads use the shared `stringValue` so they match the other timeline sweeps.
 */
function nonBlankText(value: unknown): string | null {
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

/**
 * `xhigh` reads as "Extra High" everywhere else in the app, so route known
 * efforts through the shared label. A provider is free to report one Argmax
 * has no control for (Codex has a `minimal` tier); show it rather than swallow
 * it, since it is the effort the subagent actually ran at.
 */
function effortText(raw: string): string {
  const value = raw.trim();
  const known = REASONING_EFFORTS.find((effort) => effort === value.toLowerCase());
  return known ? effortLabel(known) : value.charAt(0).toUpperCase() + value.slice(1);
}

/** The model and effort the child's own rows were produced by, newest first. */
function reportedRunModel(
  events: readonly TimelineEvent[],
  parentToolUseId: string
): { modelId: string; effort: string | null } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (!payload || payload.parent_tool_use_id !== parentToolUseId) continue;
    const modelId = nonBlankText(payload.agentModelId);
    if (!modelId) continue;
    return { modelId, effort: nonBlankText(payload.agentReasoningEffort) };
  }
  return null;
}

/**
 * What this subagent ran on. Providers say it two ways: the child's own rows
 * carry it (Claude names the model on every child envelope, Codex records model
 * and effort in the child rollout's `turn_context`), and a launch tool can pin
 * one up front (Cursor's `taskToolCall` always does, Claude's `Agent` when the
 * caller asked for it). What ran wins over what was asked for — it is also the
 * only one of the two that is a real model id rather than an alias. Null when
 * neither says, which is honest: a subagent may run a model of its own choosing
 * and the parent session's model is not evidence of it.
 */
function agentModel(
  events: readonly TimelineEvent[],
  parentToolUseId: string,
  parentTool: ToolCall | null,
  provider: ProviderId | undefined
): AgentModel | null {
  const reported = reportedRunModel(events, parentToolUseId);
  const requested = parentTool ? nonBlankText(parentTool.inputFull.model) : null;
  const reference = reported?.modelId ?? requested;
  if (!reference) return null;
  const requestedEffort = parentTool
    ? nonBlankText(parentTool.inputFull.reasoning_effort)
      ?? nonBlankText(parentTool.inputFull.reasoningEffort)
      ?? nonBlankText(parentTool.inputFull.effort)
    : null;
  const effort = reported?.effort ?? requestedEffort;
  return {
    label: (provider ? modelLabelForReference(provider, reference) : null) ?? reference.trim(),
    effort: effort ? effortText(effort) : null
  };
}

export function activityTitle(tool: ToolCall | null, parentToolUseId: string): string {
  if (!tool) return `Agent ${parentToolUseId}`;
  const description = nonBlankText(tool.inputFull.description);
  if (description) return description;
  const subagentType = nonBlankText(tool.inputFull.subagent_type) ?? nonBlankText(tool.inputFull.subagentType);
  if (subagentType) return subagentType;
  if (tool.inputPreview) return tool.inputPreview;
  return "Agent";
}

export function buildAgentActivity(params: {
  parentToolUseId: string;
  events: readonly TimelineEvent[];
  sessionRunning?: boolean;
  /** Parent session's provider, which the subagent shares. Without it a known
   *  model id can't be resolved to its catalog label and shows as the id. */
  provider?: ProviderId;
}): AgentActivity {
  const { parentToolUseId, events, sessionRunning = true, provider } = params;
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
    ? nonBlankText(parentTool.inputFull.prompt) ?? nonBlankText(parentTool.inputFull.instructions)
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
    ? nonBlankText(parentTool.inputFull.subagent_type) ?? nonBlankText(parentTool.inputFull.subagentType)
    : null;
  const status = parentTool?.status ?? "missing";
  const finalOutput = parentTool?.output && !isInternalAgentLaunchMetadata(parentTool.output)
    ? parentTool.output
    : null;
  return {
    parentTool,
    title: activityTitle(parentTool, parentToolUseId),
    prompt,
    subagentType,
    model: agentModel(events, parentToolUseId, parentTool, provider),
    status,
    items,
    finalOutput,
    limited: parentTool !== null && visibleChildMessages.length === 0 && childToolIds.size === 0,
    receiverThreadIds
  };
}
