import { modelLabelForReference, REASONING_EFFORTS } from "../../shared/providerModels.js";
import type { NativeAgentIdentity, ProviderId, TimelineEvent } from "../../shared/types.js";
import { isInternalAgentLaunchMetadata } from "./agentLaunch.js";
import { agentRootToolUseId } from "./agentNames.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import { effortLabel } from "./models.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import { getToolTypeBucket, type ToolCall } from "./toolCalls.js";

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

function receiverThreadIdsFromTool(tool: ToolCall | null): string[] {
  if (!tool) return [];
  return [
    ...stringArray(tool.inputFull.receiver_thread_ids),
    ...stringArray(tool.inputFull.receiverThreadIds)
  ];
}

function isChildMessage(
  event: TimelineEvent,
  parentToolUseId: string,
  receiverThreadIds: readonly string[]
): boolean {
  const decoded = decodeTimelineEvent(event);
  if ((decoded.kind !== "message" || decoded.role !== "assistant") && decoded.kind !== "error") {
    return false;
  }
  if (decoded.parentToolUseId === parentToolUseId) return true;
  const threadId = decoded.providerThreadId;
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
  parentToolUseId: string,
  agentRunId: string | null,
  providerInvocationId: string | null,
  nativeIdentity: NativeAgentIdentity | null
): { modelId: string; effort: string | null } | null {
  let newest: { modelId: string; effort: string | null; createdAt: string; rowCursor: number | null } | null = null;
  for (const event of events) {
    const decoded = decodeTimelineEvent(event);
    const belongsToAgent = decoded.parentToolUseId === parentToolUseId ||
      (decoded.kind === "agent" && decoded.agentRootToolUseId === parentToolUseId) ||
      (decoded.kind === "tool" && decoded.toolUseId === parentToolUseId);
    if (!belongsToAgent ||
      (nativeIdentity && (
        decoded.providerParentConversationId !== nativeIdentity.providerParentConversationId ||
        decoded.providerChildSessionId !== nativeIdentity.providerChildSessionId
      )) ||
      (agentRunId && decoded.agentRunId !== agentRunId) ||
      (providerInvocationId && decoded.providerInvocationId !== providerInvocationId)) continue;
    const modelId = decoded.agentModelId;
    if (!modelId) continue;
    const candidate = {
      modelId,
      effort: decoded.agentReasoningEffort,
      createdAt: event.createdAt,
      rowCursor: typeof event.rowCursor === "number" ? event.rowCursor : null
    };
    if (newest === null) {
      newest = candidate;
      continue;
    }
    const cursorIsNewer = newest.rowCursor !== null && candidate.rowCursor !== null &&
      candidate.rowCursor > newest.rowCursor;
    const timeIsNewer = (newest.rowCursor === null || candidate.rowCursor === null ||
      newest.rowCursor === candidate.rowCursor) &&
      candidate.createdAt > newest.createdAt;
    if (cursorIsNewer || timeIsNewer) newest = candidate;
  }
  return newest ? { modelId: newest.modelId, effort: newest.effort } : null;
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
  agentRunId: string | null,
  providerInvocationId: string | null,
  nativeIdentity: NativeAgentIdentity | null,
  provider: ProviderId | undefined
): AgentModel | null {
  const reported = reportedRunModel(
    events,
    parentToolUseId,
    agentRunId,
    providerInvocationId,
    nativeIdentity
  );
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
  agentRunId?: string | null;
  providerInvocationId?: string | null;
  nativeIdentity?: NativeAgentIdentity | null;
  events: readonly TimelineEvent[];
  sessionRunning?: boolean;
  sessionInterrupted?: boolean;
  /** Parent session's provider, which the subagent shares. Without it a known
   *  model id can't be resolved to its catalog label and shows as the id. */
  provider?: ProviderId;
}): AgentActivity {
  const { parentToolUseId, agentRunId = null, providerInvocationId = null, nativeIdentity = null, events, sessionRunning = true, sessionInterrupted = false, provider } = params;
  const tools = buildSessionToolCalls(events, sessionRunning, sessionInterrupted);
  const identityRuns = tools.filter((tool) =>
    getToolTypeBucket(tool.name) === "agent" &&
    agentRootToolUseId(tool) === parentToolUseId &&
    (!nativeIdentity || (
      tool.providerParentConversationId === nativeIdentity.providerParentConversationId &&
      tool.providerChildSessionId === nativeIdentity.providerChildSessionId
    ))
  );
  const parentTool = (agentRunId
    ? identityRuns.find((tool) => tool.agentRunId === agentRunId &&
        (!providerInvocationId || tool.providerInvocationId === providerInvocationId))
    : identityRuns.at(-1)) ?? null;
  const receiverThreadIds = receiverThreadIdsFromTool(parentTool);
  // Native lifecycle and child rows carry both IDs. Legacy callers leave one
  // or both null, so each supplied ID narrows the run independently.
  const matchesRun = (value: Pick<ToolCall, "agentRunId" | "providerInvocationId">): boolean =>
    (!agentRunId || value.agentRunId === agentRunId) &&
    (!providerInvocationId || value.providerInvocationId === providerInvocationId);
  const childTools = tools.filter((tool) =>
    tool.parentToolUseId === parentToolUseId &&
    (!nativeIdentity || (
      tool.providerParentConversationId === nativeIdentity.providerParentConversationId &&
      tool.providerChildSessionId === nativeIdentity.providerChildSessionId
    )) &&
    matchesRun(tool)
  );
  const childMessages = events
    .filter((event) => {
      if (!isChildMessage(event, parentToolUseId, receiverThreadIds)) return false;
      const decoded = decodeTimelineEvent(event);
      return (!nativeIdentity || (
        decoded.providerParentConversationId === nativeIdentity.providerParentConversationId &&
        decoded.providerChildSessionId === nativeIdentity.providerChildSessionId
      )) && matchesRun(decoded);
    })
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
  const lifecycle = events
    .filter((event) => {
      const decoded = decodeTimelineEvent(event);
      return decoded.kind === "agent" &&
        decoded.agentRootToolUseId === parentToolUseId &&
        (!nativeIdentity || (
          decoded.providerParentConversationId === nativeIdentity.providerParentConversationId &&
          decoded.providerChildSessionId === nativeIdentity.providerChildSessionId
        )) &&
        (!agentRunId || decoded.agentRunId === agentRunId) &&
        (!providerInvocationId || decoded.providerInvocationId === providerInvocationId);
    })
    .sort((a, b) => {
      const aCursor = typeof a.rowCursor === "number" ? a.rowCursor : null;
      const bCursor = typeof b.rowCursor === "number" ? b.rowCursor : null;
      if (aCursor !== null && bCursor !== null && aCursor !== bCursor) return aCursor - bCursor;
      const time = a.createdAt.localeCompare(b.createdAt);
      if (time !== 0) return time;
      return Number(a.type === "agent.completed") - Number(b.type === "agent.completed");
    });
  const latestLifecycle = lifecycle.at(-1);
  const latestAgentEvent = latestLifecycle ? decodeTimelineEvent(latestLifecycle) : null;
  const status = latestAgentEvent?.kind === "agent"
    ? latestAgentEvent.phase === "started"
      ? sessionInterrupted ? "error" : "running"
      : latestAgentEvent.status === "completed" || latestAgentEvent.status === "success"
        ? "done"
        : "error"
    : parentTool?.status ?? "missing";
  const lifecycleResult = latestAgentEvent?.kind === "agent" && latestAgentEvent.phase === "completed" &&
    latestLifecycle?.message !== "Agent completed"
    ? latestLifecycle?.message ?? null
    : null;
  const candidateFinalOutput = lifecycleResult ?? (
    parentTool?.output && !isInternalAgentLaunchMetadata(parentTool.output)
      ? parentTool.output
      : null
  );
  const duplicatesVisibleAnswer = candidateFinalOutput !== null && visibleChildMessages.some((event) => {
    const decoded = decodeTimelineEvent(event);
    return decoded.kind === "message" &&
      decoded.content === "answer" &&
      normalizedPromptEcho(event.message) === normalizedPromptEcho(candidateFinalOutput);
  });
  const finalOutput = duplicatesVisibleAnswer ? null : candidateFinalOutput;
  return {
    parentTool,
    title: activityTitle(parentTool, parentToolUseId),
    prompt,
    subagentType,
    model: agentModel(
      events,
      parentToolUseId,
      parentTool,
      agentRunId,
      providerInvocationId,
      nativeIdentity,
      provider
    ),
    status,
    items,
    finalOutput,
    limited: parentTool !== null && visibleChildMessages.length === 0 && childToolIds.size === 0,
    receiverThreadIds
  };
}

/** Native run ids in chronological order. Legacy providers return none and
 * retain the established single-run activity pane. */
export type PersistentAgentRun = { key: string; agentRunId: string; providerInvocationId: string | null };

export function persistentAgentRuns(
  events: readonly TimelineEvent[],
  parentToolUseId: string,
  nativeIdentity: NativeAgentIdentity | null = null
): PersistentAgentRun[] {
  const runs = new Map<string, { createdAt: string; agentRunId: string; providerInvocationId: string | null }>();
  for (const event of events) {
    const decoded = decodeTimelineEvent(event);
    if (
      decoded.kind !== "agent" ||
      decoded.phase !== "started" ||
      !decoded.agentRunId ||
      decoded.agentRootToolUseId !== parentToolUseId ||
      (nativeIdentity && (
        decoded.providerParentConversationId !== nativeIdentity.providerParentConversationId ||
        decoded.providerChildSessionId !== nativeIdentity.providerChildSessionId
      ))
    ) continue;
    const key = `${decoded.providerInvocationId ?? ""}\u0000${decoded.agentRunId}`;
    const previous = runs.get(key);
    if (!previous || event.createdAt < previous.createdAt) {
      runs.set(key, { createdAt: event.createdAt, agentRunId: decoded.agentRunId, providerInvocationId: decoded.providerInvocationId });
    }
  }
  return [...runs.entries()]
    .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))
    .map(([key, run]) => ({ key, agentRunId: run.agentRunId, providerInvocationId: run.providerInvocationId }));
}
