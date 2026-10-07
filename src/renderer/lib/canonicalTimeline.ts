import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type { TimelineEvent as WireTimelineEvent } from "../../shared/bindings.js";
import { decodeToolActivity, type ToolActivity } from "./toolActivity.js";
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

type CanonicalMessageEvent = CanonicalCommon & {
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

type CanonicalToolEvent = CanonicalCommon & {
  kind: "tool";
  phase: "started" | "output" | "completed";
  toolUseId: string | null;
  name: string;
  providerName: string | null;
  invocationId: string | null;
  activity: ToolActivity | null;
  /** The chat surface that owns this row — `"todo"` for the rows behind the
   *  todo card. Stamped by the normalizer so the renderer never has to know
   *  which of the providers' shifting tool names means "plan". */
  surface: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | null;
  running: boolean;
  traceSyntheticLaunch: boolean;
};

type CanonicalApprovalEvent = CanonicalCommon & {
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

export type ProjectSourceActivity = {
  sourceId: string;
  title: string;
  kind: "file" | "url";
  location: string;
  guidance: string;
  action: "read" | "added";
  at: string;
  readLocation: string | null;
  truncated: boolean;
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
  sourceActivity: ProjectSourceActivity | null;
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

type CanonicalLifecycleEvent =
  | PlainLifecycleEvent
  | CompactionLifecycleEvent
  | ProviderLifecycleEvent
  | MoveRequestedLifecycleEvent
  | ArchiveRequestedLifecycleEvent
  | MovedLifecycleEvent
  | NoteLifecycleEvent;

type CanonicalAgentEvent = CanonicalCommon & {
  kind: "agent";
  phase: "started" | "completed";
  status: string | null;
};

type CanonicalMultitaskEvent = CanonicalCommon & {
  kind: "multitask";
  phase: "launched" | "finished";
  childSessionId: string | null;
  state: string | null;
  taskLabel: string;
  prompt: string | null;
  worktree: boolean;
  answer: string | null;
};

type CanonicalErrorEvent = CanonicalCommon & {
  kind: "error";
  code: string | null;
  operation: string | null;
  isPayloadTruncation: boolean;
};

type CanonicalVisualizationEvent = CanonicalCommon & {
  kind: "visualization";
  artifactId: string;
  title: string;
  summary: string;
  format: "html" | "image";
  mode: "wide" | null;
};

type CanonicalUnknownEvent = Omit<CanonicalCommon, "raw"> & {
  raw: RawTimelineEvent;
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
  | CanonicalVisualizationEvent
  | CanonicalUnknownEvent;

const decodedEvents = new WeakMap<RawTimelineEvent, CanonicalTimelineEvent>();

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function decodeSourceActivity(payload: Record<string, unknown>, at: string): ProjectSourceActivity | null {
  if (payload.operation !== "project-source") return null;
  const source = objectValue(payload.source);
  const sourceId = nonBlankString(source?.id);
  const title = nonBlankString(source?.title);
  const location = nonBlankString(source?.location);
  const kind = source?.kind;
  const action = payload.action;
  if (!sourceId || !title || !location || (kind !== "file" && kind !== "url") || (action !== "read" && action !== "added")) return null;
  return {
    sourceId,
    title,
    kind,
    location,
    guidance: stringValue(source?.guidance) ?? "",
    action,
    at: nonBlankString(payload.readAt) ?? nonBlankString(payload.at) ?? at,
    readLocation: nonBlankString(payload.location),
    truncated: payload.truncated === true
  };
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

function common<T extends RawTimelineEvent>(raw: T, payload: Record<string, unknown>): Omit<CanonicalCommon, "raw"> & { raw: T } {
  const context = raw.semantic?.version === 1 ? raw.semantic.context : null;
  return {
    raw,
    isRaw: context ? context.isRaw : payload.raw === true,
    parentToolUseId: context ? context.parentToolUseId : stringValue(payload.parent_tool_use_id),
    providerThreadId: context ? context.providerThreadId : providerThreadId(payload),
    agentModelId: context ? context.agentModelId : nonBlankString(payload.agentModelId),
    agentReasoningEffort: context ? context.agentReasoningEffort : nonBlankString(payload.agentReasoningEffort),
    providerChildSessionId: context ? context.providerChildSessionId : nonBlankString(payload.providerChildSessionId),
    agentRunId: context ? context.agentRunId : nonBlankString(payload.agentRunId),
    agentRootToolUseId: context ? context.agentRootToolUseId : nonBlankString(payload.agentRootToolUseId)
      ?? nonBlankString(payload.parentToolUseId),
    providerParentConversationId: context ? context.providerParentConversationId : nonBlankString(payload.providerParentConversationId),
    agentCodename: context ? context.agentCodename : nonBlankString(payload.agentCodename),
    providerInvocationId: context ? context.providerInvocationId : extractProviderInvocationId(payload),
    traceSuperseded: context ? context.traceSuperseded : payload.traceSyntheticSuperseded === true,
    traceImported: context ? context.traceImported : payload.traceImported === true
  };
}

/** Preserve a malformed wire payload without letting it masquerade as chat. */
export function decodeWireTimelineEvent(wire: WireTimelineEvent): TimelineEvent {
  const payload: unknown = wire.payload;
  return {
    ...wire,
    rowCursor: wire.rowCursor ?? undefined,
    payload: isPlainObject(payload)
      ? payload
      : { __argmaxInvalidPayload: true, rawPayload: payload }
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
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "message" ? event : null;
  const base = {
    ...shared,
    kind: "message" as const,
    role: meaning?.role ?? (raw.type === "user.message" ? "user" as const : "assistant" as const),
    delivery: meaning ? meaning.delivery : (raw.type === "user.message" && payload.delivery === "steer" ? "steer" : null),
    phase: meaning?.phase ?? (raw.type === "message.delta" ? "delta" as const : "completed" as const),
    content: meaning?.content ?? (raw.type === "message.delta" && payload.thinking === true
      ? "thinking" as const
      : "answer" as const),
    childProse: (meaning?.role ?? (raw.type === "user.message" ? "user" : "assistant")) !== "user" &&
      (shared.parentToolUseId !== null || shared.providerThreadId !== null),
    rawStream: meaning?.rawStream ?? (payload.stream === "stdout" || payload.stream === "stderr" || payload.stream === "pty")
  };
  return Object.defineProperty(base, "cumulativeText", {
    enumerable: true,
    get: () => meaning ? meaning.cumulativeText : cursorCumulativeText(payload)
  }) as CanonicalMessageEvent;
}

function decodeTool(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalToolEvent {
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "tool" ? event : null;
  const phase = meaning?.phase ?? (raw.type.slice("command.".length) as CanonicalToolEvent["phase"]);
  const status = stringValue(payload.status)?.toLowerCase() ?? null;
  const shared = common(raw, payload);
  return {
    ...shared,
    kind: "tool",
    phase,
    toolUseId: meaning ? meaning.toolUseId : (phase === "started"
      ? extractToolUseId(payload) ?? raw.id
      : extractCompletionCorrelationId(payload)),
    name: meaning?.name ?? extractToolName(payload),
    providerName: meaning ? meaning.providerName : stringValue(payload.name),
    invocationId: shared.providerInvocationId,
    activity: decodeToolActivity(payload.activity),
    surface: meaning ? meaning.surface : stringValue(payload.surface),
    outcome: meaning ? meaning.outcome : (phase === "completed"
      ? payload.cancelled === true || payload.canceled === true || status && ["cancelled", "canceled", "interrupted"].includes(status) ? "cancelled"
        : detectToolError(payload) ? "failed" : "succeeded"
      : null),
    running: meaning?.running ?? (phase !== "completed" || status === "running" || status === "started" || status === "in_progress"),
    traceSyntheticLaunch: meaning?.traceSyntheticLaunch ?? payload.traceSyntheticLaunch === true
  };
}

function decodeApproval(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalApprovalEvent {
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "approval" ? event : null;
  const phase = meaning?.phase ?? (raw.type === "approval.requested"
    ? "requested"
    : raw.type === "approval.resolved" ? "resolved" : "blocked");
  const shared = common(raw, payload);
  return {
    ...shared,
    kind: "approval",
    phase,
    approvalId: meaning ? meaning.approvalId : stringValue(payload.approvalId),
    provider: meaning ? meaning.provider : stringValue(payload.provider),
    providerInvocationId: shared.providerInvocationId,
    providerRequestId: meaning ? meaning.providerRequestId : stringValue(payload.providerRequestId),
    toolUseId: meaning ? meaning.toolUseId : stringValue(payload.toolUseId) ?? stringValue(payload.tool_use_id),
    resolution: meaning ? meaning.resolution : stringValue(payload.status) ?? stringValue(payload.resolution),
    command: stringValue(payload.command),
    cwd: stringValue(payload.cwd),
    riskLevel: stringValue(payload.riskLevel)
  };
}

function decodeAgent(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalAgentEvent {
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "agent" ? event : null;
  const shared = common(raw, payload);
  return {
    ...shared,
    kind: "agent",
    phase: meaning?.phase ?? (raw.type === "agent.started" ? "started" : "completed"),
    providerInvocationId: shared.providerInvocationId,
    status: meaning ? meaning.status : stringValue(payload.status)
  };
}

function decodeLifecycle(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalLifecycleEvent {
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const name = event?.kind === "lifecycle" ? event.name : raw.type.slice("session.".length);
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
      operation: stringValue(payload.operation),
      sourceActivity: decodeSourceActivity(payload, raw.createdAt)
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
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "multitask" ? event : null;
  return {
    ...common(raw, payload),
    kind: "multitask",
    phase: meaning?.phase ?? (raw.type === "multitask.launched" ? "launched" : "finished"),
    childSessionId: meaning ? meaning.childSessionId : stringValue(payload.childSessionId),
    state: meaning ? meaning.state : stringValue(payload.state),
    taskLabel: (meaning ? meaning.taskLabel : stringValue(payload.taskLabel)) ?? raw.message,
    prompt: meaning ? meaning.prompt : stringValue(payload.prompt),
    worktree: meaning ? meaning.worktree : payload.worktree === true,
    answer: meaning ? meaning.answer : stringValue(payload.answer)
  };
}

function decodeError(raw: TimelineEvent, payload: Record<string, unknown>): CanonicalErrorEvent {
  const event = raw.semantic?.version === 1 ? raw.semantic.event : null;
  const meaning = event?.kind === "error" ? event : null;
  return {
    ...common(raw, payload),
    kind: "error",
    code: meaning ? meaning.code : stringValue(payload.code),
    operation: meaning ? meaning.operation : stringValue(payload.operation),
    isPayloadTruncation: raw.message === "event payload truncated" && "truncatedEventId" in payload
  };
}

export function decodeTimelineEvent(raw: RawTimelineEvent): CanonicalTimelineEvent {
  const cached = decodedEvents.get(raw);
  if (cached) return cached;
  const payloadValue: unknown = raw.payload;
  if (!isPlainObject(payloadValue) || payloadValue.__argmaxInvalidPayload === true) {
    const decoded: CanonicalUnknownEvent = {
      ...common(raw, {}),
      kind: "unknown",
      reason: "invalid-payload"
    };
    decodedEvents.set(raw, decoded);
    return decoded;
  }
  const payload = payloadValue;
  const validRaw = raw as TimelineEvent;
  const meaning = raw.semantic?.version === 1 ? raw.semantic.event : null;
  let decoded: CanonicalTimelineEvent;
  if (meaning?.kind === "message") {
    decoded = decodeMessage(validRaw, payload);
  } else if (meaning?.kind === "tool") {
    decoded = decodeTool(validRaw, payload);
  } else if (meaning?.kind === "approval") {
    decoded = decodeApproval(validRaw, payload);
  } else if (meaning?.kind === "agent") {
    decoded = decodeAgent(validRaw, payload);
  } else if (meaning?.kind === "lifecycle") {
    decoded = decodeLifecycle(validRaw, payload);
  } else if (meaning?.kind === "multitask") {
    decoded = decodeMultitask(validRaw, payload);
  } else if (meaning?.kind === "visualization") {
    decoded = { ...common(validRaw, payload), ...meaning };
  } else if (!meaning && raw.type === "visualization.published" && typeof payload.artifactId === "string" && typeof payload.title === "string" && typeof payload.summary === "string" && (payload.format === "html" || payload.format === "image")) {
    decoded = { ...common(validRaw, payload), kind: "visualization", artifactId: payload.artifactId, title: payload.title, summary: payload.summary, format: payload.format, mode: payload.mode === "wide" ? "wide" : null };
  } else if (meaning?.kind === "error") {
    decoded = decodeError(validRaw, payload);
  } else if (meaning?.kind === "unknown") {
    decoded = { ...common(validRaw, payload), kind: "unknown", reason: meaning.reason === "invalid-payload" ? "invalid-payload" : "unsupported-type" };
  } else if (raw.type === "user.message" || raw.type === "message.delta" || raw.type === "message.completed") {
    decoded = decodeMessage(validRaw, payload);
  } else if (raw.type === "command.started" || raw.type === "command.output" || raw.type === "command.completed") {
    decoded = decodeTool(validRaw, payload);
  } else if (raw.type === "approval.requested" || raw.type === "approval.resolved" || raw.type === "permission.blocked") {
    decoded = decodeApproval(validRaw, payload);
  } else if (raw.type === "agent.started" || raw.type === "agent.completed") {
    decoded = decodeAgent(validRaw, payload);
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
    decoded = decodeLifecycle(validRaw, payload);
  } else if (raw.type === "multitask.launched" || raw.type === "multitask.finished") {
    decoded = decodeMultitask(validRaw, payload);
  } else if (raw.type === "error") {
    decoded = decodeError(validRaw, payload);
  } else {
    decoded = { ...common(raw, payload), kind: "unknown", reason: "unsupported-type" };
  }
  decodedEvents.set(raw, decoded);
  return decoded;
}
