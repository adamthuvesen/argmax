import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../../persistence/database.js";
import type { EventType } from "../../../shared/types.js";
import { costOf, type UsageCounts } from "../../../shared/providerModels.js";
import { arrayValue, objectValue, stringValue } from "../../../shared/typeGuards.js";
import type { ProviderEvent } from "../providerTypes.js";
import { classifyCommandRisk } from "./shared.js";
import type { NormalizedUsage } from "./types.js";

export const claudeEventMap: Record<string, EventType> = {
  message_start: "message.delta",
  content_block_start: "message.delta",
  content_block_delta: "message.delta",
  content_block_stop: "message.delta",
  message_delta: "message.delta",
  message_stop: "message.completed",
  assistant: "message.completed",
  tool_use: "command.started",
  tool_result: "command.completed",
  error: "error"
};

const HIGH_RISK_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

function classifyToolRisk(tool: string): "low" | "medium" | "high" {
  if (HIGH_RISK_TOOLS.has(tool)) return "high";
  return "medium";
}

function commandFromClaudePermissionMessage(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(/^User approval required to run:\s*(.+)$/s);
  const command = match?.[1]?.trim();
  return command ? command : null;
}

export interface PermissionGateInfo {
  command: string;
  reason: string;
  riskLevel: "low" | "medium" | "high";
  cwd?: string;
  toolName?: string;
  toolUseId?: string;
}

export function detectClaudePermissionGate(
  payload: Record<string, unknown>
): PermissionGateInfo | null {
  if (stringValue(payload.type) === "system" && stringValue(payload.subtype) === "permission_denied") {
    const tool = stringValue(payload.tool_name) ?? "tool";
    const command = commandFromClaudePermissionMessage(stringValue(payload.message)) ?? tool;
    const reason =
      stringValue(payload.decision_reason) ?? stringValue(payload.message) ?? "permission denied";
    return {
      command,
      reason,
      riskLevel: command === tool ? classifyToolRisk(tool) : classifyCommandRisk(command),
      ...(command !== tool ? { toolName: tool } : {}),
      ...(stringValue(payload.tool_use_id) ? { toolUseId: stringValue(payload.tool_use_id) as string } : {})
    };
  }
  return null;
}

export function extractClaudeInlineToolBlocks(
  event: ProviderEvent,
  payload: Record<string, unknown>
): PersistTimelineEventInput[] {
  const results: PersistTimelineEventInput[] = [];
  const message = objectValue(payload.message);
  const content = arrayValue(message?.content) ?? arrayValue(payload.content);
  if (!content) {
    return results;
  }
  for (const block of content) {
    const blockObj = objectValue(block);
    if (!blockObj) continue;
    const blockType = stringValue(blockObj.type);
    if (blockType === "tool_use") {
      results.push({
        id: randomUUID(),
        sessionId: event.sessionId,
        type: "command.started",
        message: stringValue(blockObj.name) ?? "tool_use",
        payload: blockObj,
        createdAt: event.createdAt
      });
    } else if (blockType === "tool_result") {
      results.push({
        id: randomUUID(),
        sessionId: event.sessionId,
        type: "command.completed",
        message: "tool_result",
        payload: blockObj,
        createdAt: event.createdAt
      });
    }
  }
  return results;
}

export function extractClaudeMessageContent(payload: Record<string, unknown>): string | null {
  const message = objectValue(payload.message);
  const content = arrayValue(message?.content) ?? arrayValue(payload.content);
  if (!content) {
    return null;
  }

  const text = content
    .map((entry) => stringValue(objectValue(entry)?.text))
    .filter((value): value is string => Boolean(value))
    .join("");

  return text || null;
}

export function extractClaudeDeltaText(payload: Record<string, unknown>): string | null {
  const delta = objectValue(payload.delta);
  return stringValue(delta?.text);
}

export function extractClaudeUsage(
  payload: Record<string, unknown>,
  providerType: string | null
): NormalizedUsage | null {
  if (providerType !== "assistant") return null;
  const message = objectValue(payload.message);
  if (!message) return null;
  const usage = objectValue(message.usage);
  if (!usage) return null;
  const modelId = stringValue(message.model);
  if (!modelId) return null;
  const tokens: UsageCounts = {
    input: numberValue(usage.input_tokens),
    output: numberValue(usage.output_tokens),
    cacheRead: numberValue(usage.cache_read_input_tokens),
    cacheWrite: numberValue(usage.cache_creation_input_tokens)
  };
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) {
    return null;
  }
  const result: NormalizedUsage = {
    modelId,
    tokens,
    costUsd: costOf(tokens, modelId)
  };
  const eventId = stringValue(message.id);
  if (eventId) {
    result.eventId = eventId;
  }
  return result;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function shouldDropClaudeSubAgentProse(payload: Record<string, unknown>): boolean {
  return typeof payload.parent_tool_use_id === "string" && payload.parent_tool_use_id.length > 0;
}
