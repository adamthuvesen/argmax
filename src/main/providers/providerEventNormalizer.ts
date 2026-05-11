import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../persistence/database.js";
import type { EventType, ProviderId } from "../../shared/types.js";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import { stripTerminalControls } from "../../shared/terminalControls.js";
import type { ProviderEvent } from "./providerTypes.js";

export interface NormalizeProviderEventOptions {
  provider?: ProviderId;
}

export function normalizeProviderEvent(
  event: ProviderEvent,
  options: NormalizeProviderEventOptions = {}
): PersistTimelineEventInput[] {
  if (event.type !== "output") {
    return [];
  }

  const lines = event.message.split(/\r?\n/);
  const completedLines = lines.slice(0, -1);
  const trailing = lines[lines.length - 1] ?? "";
  const candidates = trailing.length > 0 ? [...completedLines, trailing] : completedLines;

  const results: PersistTimelineEventInput[] = [];
  let parsedAny = false;

  for (const rawLine of candidates) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const payload = tryParseJsonObject(line);
    if (payload) {
      parsedAny = true;
      results.push(...normalizeJsonPayload(event, payload, options.provider));
      continue;
    }

    if (event.stream === "pty") {
      // PTY non-JSON lines are terminal noise; handled by raw fallback below
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
    return results;
  }

  if (event.stream === "pty") {
    return [];
  }

  // No newlines, no JSON, no individual lines parsed — fall back to whole-message raw event.
  const cleaned = stripTerminalControls(event.message).trim();
  if (!cleaned) {
    return [];
  }
  return [
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
  ];
}

function normalizeJsonPayload(
  event: ProviderEvent,
  payload: Record<string, unknown>,
  provider: ProviderId | undefined
): PersistTimelineEventInput[] {
  const providerType = stringValue(payload.type);
  const item = objectValue(payload.item);
  const itemType = stringValue(item?.type);
  const text = extractMessageText(payload, item);

  if (isLifecycleEvent(providerType, itemType)) {
    return [];
  }

  const results: PersistTimelineEventInput[] = [];

  if (provider === "codex") {
    const codexToolEvent = normalizeCodexToolItem(event, payload, providerType, item, itemType);
    if (codexToolEvent) {
      return [codexToolEvent];
    }
  }

  // Extract inline tool_use / tool_result blocks from Claude's structured output format.
  // Claude Code (stream-json mode) sends complete turns as:
  //   {"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"...","input":{...}}]}}
  //   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
  // The outer types ("assistant", "user") are handled below for text; the inner blocks are extracted here.
  const message = objectValue(payload.message);
  const content = arrayValue(message?.content) ?? arrayValue(payload.content);
  if (content) {
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
  }

  const mappedType = mapProviderType(providerType, itemType, provider);

  // Don't create a message event if there's nothing to say.
  if (isMessageEvent(mappedType) && !text) {
    return results;
  }
  if (!mappedType && !text) {
    return results;
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

  return results;
}

function normalizeCodexToolItem(
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
  if (Object.keys(input).length > 0) {
    return input;
  }
  return {};
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

function extractClaudeMessageContent(payload: Record<string, unknown>): string | null {
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

function extractClaudeDeltaText(payload: Record<string, unknown>): string | null {
  const delta = objectValue(payload.delta);
  return stringValue(delta?.text);
}

const claudeEventMap: Record<string, EventType> = {
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

const codexEventMap: Record<string, EventType> = {
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

export function mapProviderType(
  providerType: string | null,
  itemType: string | null,
  provider: ProviderId | undefined
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

  // No provider hint: try both maps for back-compat, but prefer no leakage.
  // Look up only in maps where the key is provider-shared.
  return claudeEventMap[providerType] ?? codexEventMap[providerType] ?? null;
}

function isLifecycleEvent(providerType: string | null, itemType: string | null): boolean {
  return (
    itemType !== "agent_message" &&
    (providerType === "thread.started" ||
      providerType === "turn.started" ||
      providerType === "turn.completed" ||
      providerType === "session.started")
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isMessageEvent(eventType: EventType | null): boolean {
  return eventType === "message.delta" || eventType === "message.completed";
}
