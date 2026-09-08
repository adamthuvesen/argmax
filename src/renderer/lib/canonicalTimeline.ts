import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type {
  ProviderId,
  RawTimelineEvent,
  TimelineEvent
} from "../../shared/types.js";
import {
  arrayValue,
  isPlainObject,
  objectValue,
  stringValue
} from "../../shared/typeGuards.js";
import {
  detectToolError,
  extractCompletionCorrelationId,
  extractProviderInvocationId,
  extractToolName,
  extractToolUseId
} from "./toolCalls.js";

export type { RawTimelineEvent } from "../../shared/types.js";

type CanonicalCommon = {
  raw: TimelineEvent;
  isRaw: boolean;
  parentToolUseId: string | null;
  providerThreadId: string | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  /** Stable native child identity for providers that support resuming a subagent. */
  providerChildSessionId: string | null;
  /** One invocation of a persistent native child. */
  agentRunId: string | null;
  agentRootToolUseId: string | null;
  providerParentConversationId: string | null;
  agentCodename: string | null;
  providerInvocationId: string | null;
  traceSuperseded: boolean;
  traceImported: boolean;
};

export type CanonicalMessageEvent = CanonicalCommon & {
  kind: "message";
  role: "user" | "assistant";
  /** A mid-turn user message accepted without ending the provider turn. */
  delivery: "steer" | null;
  phase: "delta" | "completed";
  content: "answer" | "thinking";
  childProse: boolean;
  rawStream: boolean;
  /** Cursor's turn-cumulative assistant text. Computed lazily to avoid retaining quadratic copies. */
  readonly cumulativeText: string | null;
};

export type CanonicalToolEvent = CanonicalCommon & {
  kind: "tool";
  phase: "started" | "output" | "completed";
  toolUseId: string | null;
  name: string;
  providerName: string | null;
  invocationId: string | null;
  outcome: "succeeded" | "failed" | null;
  running: boolean;
  traceSyntheticLaunch: boolean;
};

export type CanonicalApprovalEvent = CanonicalCommon & {
  kind: "approval";
  phase: "requested" | "resolved" | "blocked";
  approvalId: string | null;
  provider: string | null;
  providerInvocationId: string | null;
  providerRequestId: string | null;
  toolUseId: string | null;
  resolution: string | null;
  command: string | null;
  cwd: string | null;
  riskLevel: string | null;
};

type PlainLifecycleName =
  | "started"
  | "streaming"
  | "completed"
  | "cancelled"
  | "cleared"
  | "recovered-from-crash";

type PlainLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: PlainLifecycleName;
};

type CompactionLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "compacting" | "compacted";
  preTokens: number | null;
  postTokens: number | null;
};

type ProviderLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "provider-changed";
  from: string | null;
  to: string;
  modelLabel: string | null;
};

type MoveRequestedLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "move-requested";
  destinationProjectId: string | null;
  destinationProjectName: string | null;
  worktree: boolean | null;
  keepSource: boolean | null;
};

type ArchiveRequestedLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "archive-requested";
  workspaceId: string | null;
};

/**
 * A plain line Argmax wrote into the chat about something it did to the
 * session itself — resuming a scheduled move or archive, or dropping one the
 * turn never earned. Not a failure: the turn's own error, if there was one, is
 * its own row.
 */
type NoteLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "note";
  operation: string | null;
};

type MovedLifecycleEvent = CanonicalCommon & {
  kind: "lifecycle";
  name: "moved";
  direction: "source" | "destination" | null;
  sourceSessionId: string | null;
  sourceWorkspaceId: string | null;
  sourceProjectName: string | null;
  destinationSessionId: string | null;
  destinationWorkspaceId: string | null;
  destinationProjectName: string | null;
  destinationPath: string | null;
  checkoutMode: "shared" | "worktree" | "attached" | null;
  sourceArchiveState: string | null;
};

export type CanonicalLifecycleEvent =
  | PlainLifecycleEvent
  | CompactionLifecycleEvent
  | ProviderLifecycleEvent
  | MoveRequestedLifecycleEvent
  | ArchiveRequestedLifecycleEvent
  | MovedLifecycleEvent
  | NoteLifecycleEvent;

export type CanonicalAgentEvent = CanonicalCommon & {
  kind: "agent";
  phase: "started" | "completed";
  status: string | null;
};

export type CanonicalMultitaskEvent = CanonicalCommon & {
  kind: "multitask";
  phase: "launched" | "finished";
  childSessionId: string | null;
  state: string | null;
  taskLabel: string;
  prompt: string | null;
  worktree: boolean;
  answer: string | null;
};

export type CanonicalErrorEvent = CanonicalCommon & {
  kind: "error";
  code: string | null;
  operation: string | null;
  isPayloadTruncation: boolean;
};

export type CanonicalUnknownEvent = CanonicalCommon & {
  kind: "unknown";
  reason: "invalid-payload" | "unsupported-type";
};

export type CanonicalTimelineEvent =
  | CanonicalMessageEvent
  | CanonicalToolEvent
  | CanonicalApprovalEvent
  | CanonicalLifecycleEvent
  | CanonicalAgentEvent
  | CanonicalMultitaskEvent
  | CanonicalErrorEvent
  | CanonicalUnknownEvent;

const decodedEvents = new WeakMap<RawTimelineEvent, CanonicalTimelineEvent>();

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function providerDisplayName(value: unknown): string | null {
  const provider = stringValue(value);
  return provider ? PROVIDER_DISPLAY_NAMES[provider as ProviderId] ?? provider : null;
}

function providerThreadId(payload: Record<string, unknown>): string | null {
  const item = objectValue(payload.item);
  const isAgentMessage = payload.item_type === "agent_message" || item?.type === "agent_message";
  if (!isAgentMessage) return null;
  return stringValue(payload.thread_id)
    ?? stringValue(payload.sender_thread_id)
    ?? stringValue(item?.thread_id)
    ?? stringValue(item?.sender_thread_id);
}

function common(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalCommon {
  return {
    raw,
    isRaw: payload.raw === true,
    parentToolUseId: stringValue(payload.parent_tool_use_id),
    providerThreadId: providerThreadId(payload),
    agentModelId: nonBlankString(payload.agentModelId),
    agentReasoningEffort: nonBlankString(payload.agentReasoningEffort),
    providerChildSessionId: nonBlankString(payload.providerChildSessionId),
    agentRunId: nonBlankString(payload.agentRunId),
    agentRootToolUseId: nonBlankString(payload.agentRootToolUseId)
      ?? nonBlankString(payload.parentToolUseId),
    providerParentConversationId: nonBlankString(payload.providerParentConversationId),
    agentCodename: nonBlankString(payload.agentCodename),
    providerInvocationId: extractProviderInvocationId(payload),
    traceSuperseded: payload.traceSyntheticSuperseded === true,
    traceImported: payload.traceImported === true
  };
}

function cursorCumulativeText(payload: Record<string, unknown>): string | null {
  if (payload.type !== "assistant") return null;
  const content = arrayValue(objectValue(payload.message)?.content);
  if (!content) return null;
  const parts: string[] = [];
  for (const entry of content) {
    const text = stringValue(objectValue(entry)?.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function decodeMessage(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalMessageEvent {
  const shared = common(raw, payload);
  const base = {
    ...shared,
    kind: "message" as const,
    role: raw.type === "user.message" ? "user" as const : "assistant" as const,
    delivery: raw.type === "user.message" && payload.delivery === "steer" ? "steer" : null,
    phase: raw.type === "message.delta" ? "delta" as const : "completed" as const,
    content: raw.type === "message.delta" && payload.thinking === true
      ? "thinking" as const
      : "answer" as const,
    childProse: raw.type !== "user.message" &&
      (shared.parentToolUseId !== null || shared.providerThreadId !== null),
    rawStream: payload.stream === "stdout" || payload.stream === "stderr" || payload.stream === "pty"
  };
  return Object.defineProperty(base, "cumulativeText", {
    enumerable: true,
    get: () => cursorCumulativeText(payload)
  }) as CanonicalMessageEvent;
}

function decodeTool(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalToolEvent {
  const phase = raw.type.slice("command.".length) as CanonicalToolEvent["phase"];
  const status = stringValue(payload.status)?.toLowerCase() ?? null;
  return {
    ...common(raw, payload),
    kind: "tool",
    phase,
    toolUseId: phase === "started"
      ? extractToolUseId(payload) ?? raw.id
      : extractCompletionCorrelationId(payload),
    name: extractToolName(payload),
    providerName: stringValue(payload.name),
    invocationId: extractProviderInvocationId(payload),
    outcome: phase === "completed" ? (detectToolError(payload) ? "failed" : "succeeded") : null,
    running: phase !== "completed" || status === "running" || status === "started" || status === "in_progress",
    traceSyntheticLaunch: payload.traceSyntheticLaunch === true
  };
}

function decodeApproval(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalApprovalEvent {
  const phase = raw.type === "approval.requested"
    ? "requested"
    : raw.type === "approval.resolved" ? "resolved" : "blocked";
  return {
    ...common(raw, payload),
    kind: "approval",
    phase,
    approvalId: stringValue(payload.approvalId),
    provider: stringValue(payload.provider),
    providerInvocationId: extractProviderInvocationId(payload),
    providerRequestId: stringValue(payload.providerRequestId),
    toolUseId: stringValue(payload.toolUseId) ?? stringValue(payload.tool_use_id),
    resolution: stringValue(payload.status) ?? stringValue(payload.resolution),
    command: stringValue(payload.command),
    cwd: stringValue(payload.cwd),
    riskLevel: stringValue(payload.riskLevel)
  };
}

function decodeAgent(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalAgentEvent {
  return {
    ...common(raw, payload),
    kind: "agent",
    phase: raw.type === "agent.started" ? "started" : "completed",
    providerInvocationId: extractProviderInvocationId(payload),
    status: stringValue(payload.status)
  };
}

function decodeLifecycle(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalLifecycleEvent {
  const name = raw.type.slice("session.".length);
  const shared = common(raw, payload);
  if (name === "compacting" || name === "compacted") {
    return { ...shared, kind: "lifecycle", name, preTokens: positiveNumber(payload.preTokens), postTokens: positiveNumber(payload.postTokens) };
  }
  if (name === "provider-changed") {
    return {
      ...shared,
      kind: "lifecycle",
      name,
      from: providerDisplayName(payload.from),
      to: providerDisplayName(payload.provider) ?? raw.message,
      modelLabel: nonBlankString(payload.modelLabel)
    };
  }
  if (name === "move-requested") {
    return {
      ...shared,
      kind: "lifecycle",
      name,
      destinationProjectId: stringValue(payload.destinationProjectId),
      destinationProjectName: stringValue(payload.destinationProjectName),
      worktree: typeof payload.worktree === "boolean" ? payload.worktree : null,
      keepSource: typeof payload.keepSource === "boolean" ? payload.keepSource : null
    };
  }
  if (name === "archive-requested") {
    return {
      ...shared,
      kind: "lifecycle",
      name,
      workspaceId: stringValue(payload.workspaceId)
    };
  }
  if (name === "note") {
    return {
      ...shared,
      kind: "lifecycle",
      name,
      operation: stringValue(payload.operation)
    };
  }
  if (name === "moved") {
    const direction = payload.direction === "source" || payload.direction === "destination" ? payload.direction : null;
    const checkoutMode =
      payload.checkoutMode === "shared" ||
      payload.checkoutMode === "worktree" ||
      payload.checkoutMode === "attached"
        ? payload.checkoutMode
        : null;
    return {
      ...shared,
      kind: "lifecycle",
      name,
      direction,
      sourceSessionId: stringValue(payload.sourceSessionId),
      sourceWorkspaceId: stringValue(payload.sourceWorkspaceId),
      sourceProjectName: stringValue(payload.sourceProjectName),
      destinationSessionId: stringValue(payload.destinationSessionId),
      destinationWorkspaceId: stringValue(payload.destinationWorkspaceId),
      destinationProjectName: stringValue(payload.destinationProjectName),
      destinationPath: stringValue(payload.destinationPath),
      checkoutMode,
      sourceArchiveState: stringValue(payload.sourceArchiveState)
    };
  }
  return { ...shared, kind: "lifecycle", name: name as PlainLifecycleName };
}

function decodeMultitask(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalMultitaskEvent {
  return {
    ...common(raw, payload),
    kind: "multitask",
    phase: raw.type === "multitask.launched" ? "launched" : "finished",
    childSessionId: stringValue(payload.childSessionId),
    state: stringValue(payload.state),
    taskLabel: stringValue(payload.taskLabel) ?? raw.message,
    prompt: stringValue(payload.prompt),
    worktree: payload.worktree === true,
    answer: stringValue(payload.answer)
  };
}

export function decodeTimelineEvent(raw: RawTimelineEvent): CanonicalTimelineEvent {
  const cached = decodedEvents.get(raw);
  if (cached) return cached;
  const payloadValue: unknown = raw.payload;
  if (!isPlainObject(payloadValue)) {
    const decoded: CanonicalUnknownEvent = {
      ...common(raw, {}),
      kind: "unknown",
      reason: "invalid-payload"
    };
    decodedEvents.set(raw, decoded);
    return decoded;
  }
  const payload = payloadValue;
  let decoded: CanonicalTimelineEvent;
  if (raw.type === "user.message" || raw.type === "message.delta" || raw.type === "message.completed") {
    decoded = decodeMessage(raw, payload);
  } else if (raw.type === "command.started" || raw.type === "command.output" || raw.type === "command.completed") {
    decoded = decodeTool(raw, payload);
  } else if (raw.type === "approval.requested" || raw.type === "approval.resolved" || raw.type === "permission.blocked") {
    decoded = decodeApproval(raw, payload);
  } else if (raw.type === "agent.started" || raw.type === "agent.completed") {
    decoded = decodeAgent(raw, payload);
  } else if (
    raw.type === "session.started" ||
    raw.type === "session.streaming" ||
    raw.type === "session.completed" ||
    raw.type === "session.cancelled" ||
    raw.type === "session.compacting" ||
    raw.type === "session.compacted" ||
    raw.type === "session.provider-changed" ||
    raw.type === "session.cleared" ||
    raw.type === "session.move-requested" ||
    raw.type === "session.archive-requested" ||
    raw.type === "session.moved" ||
    raw.type === "session.note" ||
    raw.type === "session.recovered-from-crash"
  ) {
    decoded = decodeLifecycle(raw, payload);
  } else if (raw.type === "multitask.launched" || raw.type === "multitask.finished") {
    decoded = decodeMultitask(raw, payload);
  } else if (raw.type === "error") {
    decoded = {
      ...common(raw, payload),
      kind: "error",
      code: stringValue(payload.code),
      operation: stringValue(payload.operation),
      isPayloadTruncation: raw.message === "event payload truncated" && "truncatedEventId" in payload
    };
  } else {
    decoded = { ...common(raw, payload), kind: "unknown", reason: "unsupported-type" };
  }
  decodedEvents.set(raw, decoded);
  return decoded;
}
