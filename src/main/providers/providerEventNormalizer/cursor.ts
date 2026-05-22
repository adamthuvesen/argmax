import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../../persistence/database.js";
import type { EventType } from "../../../shared/types.js";
import { costOf, type UsageCounts } from "../../../shared/providerModels.js";
import { objectValue, stringValue } from "../../../shared/typeGuards.js";
import type { ProviderEvent } from "../providerTypes.js";
import { numberValue } from "./shared.js";
import type { NormalizedUsage, NormalizerSessionContext } from "./types.js";

export const cursorEventMap: Record<string, EventType> = {
  error: "error"
};

/**
 * Cursor-only suppression list. Stream-json emits a number of rows that don't
 * belong on the visible timeline:
 *   - `system/init` and `result/success` are lifecycle markers.
 *   - `user` is an echo of the prompt — the launch already persisted a
 *     `user.message` timeline row from the composer, so re-emitting the same
 *     text creates a duplicate bubble.
 *   - `thinking` deltas leak reasoning fragments; Argmax doesn't surface
 *     reasoning for any provider and rendering each delta produces a wall of
 *     one-line bubbles.
 * Subtype gating on `system` matters because Claude's permission-denied
 * messages also use `type:"system"`, with `subtype:"permission_denied"`.
 */
export function isCursorLifecycleEvent(providerType: string | null, subtype: string | null): boolean {
  if (providerType === "system" && subtype === "init") return true;
  if (providerType === "result" && subtype === "success") return true;
  if (providerType === "user") return true;
  if (providerType === "thinking") return true;
  return false;
}

/**
 * Cursor's `--stream-partial-output` emits cumulative snapshots on every
 * `assistant` row. The renderer concatenates `message.delta` chunks, so
 * passing the cumulative text through would render "ExplExploring the
 * repositoryExploring the repository structure..." (each later snapshot
 * piled onto the earlier ones). We strip the prior cumulative prefix so the
 * emitted delta is the true suffix; the final cumulative row (no
 * timestamp_ms → `message.completed`) resets state and emits the full text
 * so it can replace the running stream cleanly.
 */
export function normalizeCursorAssistantText(
  text: string | null,
  payload: Record<string, unknown>,
  providerType: string | null,
  context: NormalizerSessionContext
): string | null {
  if (providerType !== "assistant" || text === null) {
    return text;
  }
  const hasTimestamp = typeof payload.timestamp_ms === "number";
  if (!hasTimestamp) {
    context.cursorAssistantText = null;
    return text;
  }
  const prior = context.cursorAssistantText ?? "";
  context.cursorAssistantText = text;
  if (text.startsWith(prior)) {
    return text.slice(prior.length);
  }
  return null;
}

export function synthesizeCursorMessageCompletedFromResult(
  event: ProviderEvent,
  context: NormalizerSessionContext
): PersistTimelineEventInput | null {
  if (typeof context.cursorAssistantText !== "string") {
    return null;
  }
  const finalText = context.cursorAssistantText;
  context.cursorAssistantText = null;
  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: "message.completed",
    message: finalText,
    payload: { synthesizedFromResult: true, text: finalText },
    createdAt: event.createdAt
  };
}

export function normalizeCursorToolCall(
  event: ProviderEvent,
  payload: Record<string, unknown>,
  providerType: string | null
): PersistTimelineEventInput | null {
  if (providerType !== "tool_call") return null;
  const subtype = stringValue(payload.subtype);
  if (subtype !== "started" && subtype !== "completed") return null;

  const wrapper = objectValue(payload.tool_call);
  let toolKind: string | null = null;
  let toolBody: Record<string, unknown> | null = null;
  if (wrapper) {
    for (const key of Object.keys(wrapper)) {
      const body = objectValue(wrapper[key]);
      if (body) {
        toolKind = key;
        toolBody = body;
        break;
      }
    }
  }
  const toolName = toolKind ?? "tool_call";
  const args = toolBody ? objectValue(toolBody.args) ?? {} : {};
  const callId = stringValue(payload.call_id);
  const flattened: Record<string, unknown> = {
    name: toolName,
    input: args,
    ...(toolBody && "result" in toolBody ? { result: toolBody.result } : {}),
    ...(callId ? { call_id: callId } : {}),
    raw: payload
  };
  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: subtype === "started" ? "command.started" : "command.completed",
    message: toolName,
    payload: flattened,
    createdAt: event.createdAt
  };
}

export function extractCursorUsage(
  payload: Record<string, unknown>,
  providerType: string | null,
  context: NormalizerSessionContext | undefined
): NormalizedUsage | null {
  if (providerType !== "result") return null;
  if (stringValue(payload.subtype) !== "success") return null;
  const usage = objectValue(payload.usage);
  if (!usage) return null;
  const tokens: UsageCounts = {
    input: numberValue(usage.inputTokens),
    output: numberValue(usage.outputTokens),
    cacheRead: numberValue(usage.cacheReadTokens),
    cacheWrite: numberValue(usage.cacheWriteTokens)
  };
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) {
    return null;
  }
  const modelId = context?.cursorCurrentModel ?? "cursor-unknown";
  return {
    modelId,
    tokens,
    costUsd: costOf(tokens, modelId)
  };
}