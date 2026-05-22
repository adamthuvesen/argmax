import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../../persistence/database.js";
import type { EventType } from "../../../shared/types.js";
import { costOf, type UsageCounts } from "../../../shared/providerModels.js";
import { arrayValue, objectValue, stringValue } from "../../../shared/typeGuards.js";
import type { ProviderEvent } from "../providerTypes.js";
import { classifyCommandRisk, numberValue } from "./shared.js";
import type { NormalizedUsage, NormalizerSessionContext } from "./types.js";
import type { PermissionGateInfo } from "./claude.js";

export const codexEventMap: Record<string, EventType> = {
  "message.delta": "message.delta",
  "message.completed": "message.completed",
  "command.started": "command.started",
  "command.output": "command.output",
  "command.completed": "command.completed",
  "approval.requested": "approval.requested",
  "approval.resolved": "approval.resolved",
  "file.changed": "file.changed",
  "check.started": "check.started",
  "check.completed": "check.completed",
  error: "error"
};

export function detectCodexPermissionGate(payload: Record<string, unknown>): PermissionGateInfo | null {
  const method = stringValue(payload.method);
  if (
    !method ||
    (!method.endsWith("/requestApproval") &&
      method !== "applyPatchApproval" &&
      method !== "execCommandApproval")
  ) {
    return null;
  }
  const params = objectValue(payload.params) ?? {};
  const isFileChange =
    method.includes("fileChange") ||
    method === "applyPatchApproval" ||
    Boolean(params.fileChanges);
  const commandArray = arrayValue(params.command);
  const command = commandArray
    ? commandArray.map((c) => stringValue(c) ?? "").join(" ").trim()
    : stringValue(params.command) ?? (isFileChange ? "Apply file changes" : "Execute command");
  const reason = stringValue(params.reason) ?? "Approval required";
  return {
    command: command || (isFileChange ? "Apply file changes" : "Execute command"),
    reason,
    riskLevel: isFileChange ? "high" : classifyCommandRisk(command),
    ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) as string } : {})
  };
}

export function updateCodexTurnContextModel(
  payload: Record<string, unknown>,
  context: NormalizerSessionContext
): void {
  const model = extractCodexTurnContextModel(payload);
  if (model) {
    context.codexCurrentModel = model;
  }
}

export function extractCodexTurnContextModel(payload: Record<string, unknown>): string | null {
  return (
    stringValue(payload.model) ??
    stringValue(objectValue(payload.payload)?.model) ??
    null
  );
}

export function normalizeCodexToolItem(
  event: ProviderEvent,
  payload: Record<string, unknown>,
  providerType: string | null,
  item: Record<string, unknown> | null,
  itemType: string | null
): PersistTimelineEventInput | null {
  if (!item || !itemType || itemType === "agent_message") {
    return null;
  }
  if (providerType !== "item.started" && providerType !== "item.completed") {
    return null;
  }

  const action = objectValue(item.action);
  const toolName = stringValue(item.name) ?? itemType;
  const toolPayload = {
    ...item,
    type: toolName,
    name: toolName,
    input: extractCodexToolInput(item, action),
    providerEventType: providerType,
    raw: payload
  };

  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: providerType === "item.started" ? "command.started" : "command.completed",
    message: toolName,
    payload: toolPayload,
    createdAt: event.createdAt
  };
}

function extractCodexToolInput(
  item: Record<string, unknown>,
  action: Record<string, unknown> | null
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of ["query", "queries", "url", "path", "file_path", "command", "cmd", "pattern"] as const) {
    const value = item[key] ?? action?.[key];
    if (value !== undefined && value !== "") {
      input[key] = value;
    }
  }
  const changes = arrayValue(item.changes) ?? arrayValue(action?.changes);
  if (changes) {
    input.changes = changes;
  }
  if (Object.keys(input).length > 0) {
    return input;
  }
  return {};
}

export function extractCodexUsage(
  payload: Record<string, unknown>,
  providerType: string | null,
  context: NormalizerSessionContext | undefined
): NormalizedUsage | null {
  let rawUsage: Record<string, unknown> | null = null;

  if (providerType === "event_msg") {
    const inner = objectValue(payload.payload);
    if (inner && stringValue(inner.type) === "token_count") {
      rawUsage = objectValue(objectValue(inner.info)?.last_token_usage);
    }
  } else if (providerType === "token_count") {
    rawUsage = objectValue(objectValue(payload.info)?.last_token_usage);
  } else if (providerType === "turn.completed") {
    rawUsage = objectValue(payload.usage);
  }

  if (!rawUsage) return null;

  const inputTokens = numberValue(rawUsage.input_tokens);
  const cachedInput = numberValue(rawUsage.cached_input_tokens);
  const outputTokens = numberValue(rawUsage.output_tokens);
  if (inputTokens + outputTokens + cachedInput === 0) return null;

  const nonCachedInput = Math.max(0, inputTokens - cachedInput);

  const modelId = context?.codexCurrentModel ?? "unknown";
  const tokens: UsageCounts = {
    input: nonCachedInput,
    output: outputTokens,
    cacheRead: cachedInput,
    cacheWrite: 0
  };
  return {
    modelId,
    tokens,
    costUsd: costOf(tokens, modelId)
  };
}