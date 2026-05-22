import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../../persistence/database.js";
import type { EventType, ProviderId } from "../../../shared/types.js";
import { tryParseJsonObject } from "../../../shared/safeJson.js";
import { stripTerminalControls } from "../../../shared/terminalControls.js";
import { objectValue, stringValue } from "../../../shared/typeGuards.js";
import type { ProviderEvent } from "../providerTypes.js";
import {
  claudeEventMap,
  detectClaudePermissionGate,
  extractClaudeDeltaText,
  extractClaudeInlineToolBlocks,
  extractClaudeMessageContent,
  extractClaudeUsage,
  shouldDropClaudeSubAgentProse,
  type PermissionGateInfo
} from "./claude.js";
import {
  codexEventMap,
  detectCodexPermissionGate,
  extractCodexUsage,
  normalizeCodexToolItem,
  updateCodexTurnContextModel
} from "./codex.js";
import {
  cursorEventMap,
  extractCursorUsage,
  isCursorLifecycleEvent,
  normalizeCursorAssistantText,
  normalizeCursorToolCall,
  synthesizeCursorMessageCompletedFromResult
} from "./cursor.js";
import { isLifecycleEvent, isMessageEvent } from "./shared.js";
import {
  createNormalizerSessionContext,
  type NormalizedProviderResult,
  type NormalizedUsage,
  type NormalizeProviderEventOptions,
  type NormalizerSessionContext
} from "./types.js";

export {
  createNormalizerSessionContext,
  type NormalizedProviderResult,
  type NormalizedUsage,
  type NormalizeProviderEventOptions,
  type NormalizerSessionContext
};

/**
 * Per-line size cap before we attempt `JSON.parse`. A pathological provider
 * emitting a multi-MiB single line would otherwise block the main process
 * inside V8's parser. Raw bytes are still persisted via raw_outputs (which
 * has its own 256 KiB cap); the timeline gets a truncation marker.
 */
const JSON_PARSE_LINE_CAP = 1_048_576;

/**
 * Backward-compatible normalizer entry point — returns events only.
 * Usage extraction goes through `normalizeProviderEventWithUsage`.
 */
export function normalizeProviderEvent(
  event: ProviderEvent,
  options: NormalizeProviderEventOptions = {}
): PersistTimelineEventInput[] {
  return normalizeProviderEventWithUsage(event, options).events;
}

export function normalizeProviderEventWithUsage(
  event: ProviderEvent,
  options: NormalizeProviderEventOptions = {}
): NormalizedProviderResult {
  if (event.type !== "output") {
    return { events: [], usages: [] };
  }

  const lines = event.message.split(/\r?\n/);
  const completedLines = lines.slice(0, -1);
  const trailing = lines[lines.length - 1] ?? "";
  const candidates = trailing.length > 0 ? [...completedLines, trailing] : completedLines;

  const results: PersistTimelineEventInput[] = [];
  const usages: NormalizedUsage[] = [];
  let parsedAny = false;

  for (const rawLine of candidates) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.length > JSON_PARSE_LINE_CAP) {
      results.push({
        id: randomUUID(),
        sessionId: event.sessionId,
        type: "error",
        message: `[argmax: skipped ${line.length}-byte line (> ${JSON_PARSE_LINE_CAP} bytes); too large to parse]`,
        payload: {
          raw: true,
          stream: event.stream,
          truncated: true,
          droppedBytes: line.length
        },
        createdAt: event.createdAt
      });
      continue;
    }

    const payload = tryParseJsonObject(line);
    if (payload) {
      parsedAny = true;
      const out = normalizeJsonPayload(event, payload, options.provider, options.context);
      results.push(...out.events);
      usages.push(...out.usages);
      continue;
    }

    if (event.stream === "pty") {
      continue;
    }

    const cleaned = stripTerminalControls(line).trim();
    if (!cleaned) {
      continue;
    }

    results.push({
      id: randomUUID(),
      sessionId: event.sessionId,
      type: event.stream === "stderr" ? "error" : "message.delta",
      message: cleaned,
      payload: {
        raw: true,
        stream: event.stream
      },
      createdAt: event.createdAt
    });
  }

  if (results.length > 0 || parsedAny) {
    return { events: results, usages };
  }

  if (event.stream === "pty") {
    return { events: [], usages: [] };
  }

  const cleaned = stripTerminalControls(event.message).trim();
  if (!cleaned) {
    return { events: [], usages: [] };
  }
  return {
    events: [
      {
        id: randomUUID(),
        sessionId: event.sessionId,
        type: event.stream === "stderr" ? "error" : "message.delta",
        message: cleaned,
        payload: {
          raw: true,
          stream: event.stream
        },
        createdAt: event.createdAt
      }
    ],
    usages
  };
}

interface JsonPayloadResult {
  events: PersistTimelineEventInput[];
  usages: NormalizedUsage[];
}

function normalizeJsonPayload(
  event: ProviderEvent,
  payload: Record<string, unknown>,
  provider: ProviderId | undefined,
  context: NormalizerSessionContext | undefined
): JsonPayloadResult {
  const providerType = stringValue(payload.type);
  const item = objectValue(payload.item);
  const itemType = stringValue(item?.type);
  const rawText = extractMessageText(payload, item);
  const text =
    provider === "cursor" && context
      ? normalizeCursorAssistantText(rawText, payload, providerType, context)
      : rawText;

  if (provider === "codex" && context && providerType === "turn_context") {
    updateCodexTurnContextModel(payload, context);
  }

  const usage = extractUsageFromPayload(payload, providerType, provider, context);
  const usages = usage ? [usage] : [];

  if (isLifecycleEvent(providerType, itemType)) {
    return { events: [], usages };
  }

  if (provider === "cursor" && isCursorLifecycleEvent(providerType, stringValue(payload.subtype))) {
    if (context) {
      const synthesized = synthesizeCursorMessageCompletedFromResult(event, context);
      if (
        synthesized &&
        providerType === "result" &&
        stringValue(payload.subtype) === "success"
      ) {
        return { events: [synthesized], usages };
      }
    }
    return { events: [], usages };
  }

  const results: PersistTimelineEventInput[] = [];

  const gate = detectPermissionGate(payload, provider);
  if (gate) {
    results.push({
      id: randomUUID(),
      sessionId: event.sessionId,
      type: "approval.requested",
      message: gate.command,
      payload: {
        command: gate.command,
        reason: gate.reason,
        riskLevel: gate.riskLevel,
        ...(gate.cwd ? { cwd: gate.cwd } : {}),
        ...(gate.toolName ? { toolName: gate.toolName } : {}),
        ...(gate.toolUseId ? { toolUseId: gate.toolUseId } : {}),
        ...(providerType ? { providerEventType: providerType } : {})
      },
      createdAt: event.createdAt
    });
    return { events: results, usages };
  }

  if (provider === "codex") {
    const codexToolEvent = normalizeCodexToolItem(event, payload, providerType, item, itemType);
    if (codexToolEvent) {
      return { events: [codexToolEvent], usages };
    }
  }

  if (provider === "cursor") {
    const cursorToolEvent = normalizeCursorToolCall(event, payload, providerType);
    if (cursorToolEvent) {
      return { events: [cursorToolEvent], usages };
    }
  }

  if (provider === "claude") {
    results.push(...extractClaudeInlineToolBlocks(event, payload));
  }

  const mappedType = mapProviderType(providerType, itemType, provider, payload);

  if (isMessageEvent(mappedType) && !text) {
    return { events: results, usages };
  }
  if (!mappedType && !text) {
    return { events: results, usages };
  }

  if (provider === "claude" && shouldDropClaudeSubAgentProse(payload)) {
    return { events: results, usages };
  }

  const finalPayload = mappedType
    ? payload
    : { ...payload, unknownType: providerType };

  results.push({
    id: randomUUID(),
    sessionId: event.sessionId,
    type: mappedType ?? "message.delta",
    message: text ?? providerType ?? "Provider event",
    payload: finalPayload,
    createdAt: event.createdAt
  });

  return { events: results, usages };
}

function extractMessageText(payload: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  return (
    stringValue(item?.text) ??
    stringValue(payload.text) ??
    stringValue(payload.message) ??
    extractClaudeMessageContent(payload) ??
    extractClaudeDeltaText(payload)
  );
}

export function mapProviderType(
  providerType: string | null,
  itemType: string | null,
  provider: ProviderId | undefined,
  payload?: Record<string, unknown>
): EventType | null {
  if (itemType === "agent_message") {
    return "message.completed";
  }
  if (!providerType) {
    return null;
  }

  if (provider === "claude") {
    return claudeEventMap[providerType] ?? null;
  }
  if (provider === "codex") {
    return codexEventMap[providerType] ?? null;
  }
  if (provider === "cursor") {
    if (providerType === "assistant") {
      const hasTimestamp = payload !== undefined && typeof payload.timestamp_ms === "number";
      return hasTimestamp ? "message.delta" : "message.completed";
    }
    return cursorEventMap[providerType] ?? null;
  }

  return claudeEventMap[providerType] ?? codexEventMap[providerType] ?? null;
}

/**
 * Detects permission-gate events emitted by Claude and Codex. Returns a
 * normalized descriptor so the caller can emit a single `approval.requested`
 * timeline event regardless of provider.
 */
export function detectPermissionGate(
  payload: Record<string, unknown>,
  provider: ProviderId | undefined
): PermissionGateInfo | null {
  if (provider === "claude") {
    return detectClaudePermissionGate(payload);
  }
  if (provider === "codex") {
    return detectCodexPermissionGate(payload);
  }
  return null;
}

function extractUsageFromPayload(
  payload: Record<string, unknown>,
  providerType: string | null,
  provider: ProviderId | undefined,
  context: NormalizerSessionContext | undefined
): NormalizedUsage | null {
  if (provider === "claude") {
    return extractClaudeUsage(payload, providerType);
  }
  if (provider === "codex") {
    return extractCodexUsage(payload, providerType, context);
  }
  if (provider === "cursor") {
    return extractCursorUsage(payload, providerType, context);
  }
  return null;
}
