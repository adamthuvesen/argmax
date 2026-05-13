import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../persistence/database.js";
import type { EventType, ProviderId } from "../../shared/types.js";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import { stripTerminalControls } from "../../shared/terminalControls.js";
import { costOf, type UsageCounts } from "../../shared/providerModels.js";
import type { ProviderEvent } from "./providerTypes.js";

export interface NormalizerSessionContext {
  /** Most-recent Codex `turn_context.model` seen for this session. */
  codexCurrentModel: string | null;
}

export function createNormalizerSessionContext(): NormalizerSessionContext {
  return { codexCurrentModel: null };
}

export interface NormalizedUsage {
  modelId: string;
  tokens: UsageCounts;
  costUsd: number;
  eventId?: string;
}

export interface NormalizeProviderEventOptions {
  provider?: ProviderId;
  context?: NormalizerSessionContext;
}

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

export interface NormalizedProviderResult {
  events: PersistTimelineEventInput[];
  usages: NormalizedUsage[];
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
      // Skip JSON.parse on pathologically long lines. Surface a truncation
      // marker so the renderer reflects what happened, but keep the raw bytes
      // out of the timeline payload — they're already in raw_outputs.
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
    return { events: results, usages };
  }

  if (event.stream === "pty") {
    return { events: [], usages };
  }

  // No newlines, no JSON, no individual lines parsed — fall back to whole-message raw event.
  const cleaned = stripTerminalControls(event.message).trim();
  if (!cleaned) {
    return { events: [], usages };
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
  const text = extractMessageText(payload, item);

  // Codex turn_context updates the session-scoped current model. token_count
  // events carry usage but no model id; the parser threads the latest model
  // forward from turn_context to apply pricing correctly.
  if (provider === "codex" && context && providerType === "turn_context") {
    const model = extractCodexTurnContextModel(payload);
    if (model) {
      context.codexCurrentModel = model;
    }
  }

  const usage = extractUsageFromPayload(payload, providerType, provider, context);
  const usages = usage ? [usage] : [];

  if (isLifecycleEvent(providerType, itemType)) {
    return { events: [], usages };
  }

  const results: PersistTimelineEventInput[] = [];

  // Permission gates land before any tool-result extraction so the timeline
  // shows the request-for-approval *before* the (possibly-denied) tool_result
  // that follows. The renderer / approval service can read the payload fields
  // to surface an Approve / Reject UI.
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
    return { events: results, usages };
  }
  if (!mappedType && !text) {
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

function normalizeCursorToolCall(
  event: ProviderEvent,
  payload: Record<string, unknown>,
  providerType: string | null
): PersistTimelineEventInput | null {
  if (providerType !== "tool_call") return null;
  const subtype = stringValue(payload.subtype);
  if (subtype !== "started" && subtype !== "completed") return null;

  // Cursor wraps the tool body in a single-key object like {readToolCall: {...}}
  // or {writeToolCall: {...}}. Unwrap so the kind name and inner args/result
  // both surface on the timeline event.
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

// Cursor's --output-format stream-json shape is intentionally Claude-like:
// `assistant` rows carry message.content[].text (handled by the Claude content
// extractor), and `user` rows mirror the prompt. tool_call rows are routed
// separately by normalizeCursorToolCall.
const cursorEventMap: Record<string, EventType> = {
  assistant: "message.completed",
  user: "message.delta",
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
  if (provider === "cursor") {
    return cursorEventMap[providerType] ?? null;
  }

  // No provider hint: try both maps for back-compat, but prefer no leakage.
  // Look up only in maps where the key is provider-shared.
  return claudeEventMap[providerType] ?? codexEventMap[providerType] ?? null;
}

function isLifecycleEvent(providerType: string | null, itemType: string | null): boolean {
  if (itemType === "agent_message") return false;
  // Cursor wraps init/result as `{type:"system"|"result", subtype:"..."}`.
  // Treat both as lifecycle so they don't surface as raw timeline rows.
  // Claude never emits a bare `system` or `result` type (only message_*), so
  // gating by provider is unnecessary.
  return (
    providerType === "thread.started" ||
    providerType === "turn.started" ||
    providerType === "turn.completed" ||
    providerType === "session.started" ||
    providerType === "system" ||
    providerType === "result"
  );
}

interface PermissionGateInfo {
  command: string;
  reason: string;
  riskLevel: "low" | "medium" | "high";
  toolUseId?: string;
}

/**
 * Detects permission-gate events emitted by Claude (`SDKPermissionDeniedMessage`,
 * v2.1.136+) and Codex (`item/{commandExecution,fileChange}/requestApproval` and
 * the legacy `applyPatchApproval` / `execCommandApproval` shapes from the
 * codex-rs app-server). Returns a normalized descriptor so the caller can emit
 * a single `approval.requested` timeline event regardless of provider.
 *
 * Fixtures the schema is verified against live under `__fixtures__/`:
 *   - `claude_permission_denied.jsonl`
 *   - `codex_command_approval_request.jsonl`
 *   - `codex_file_change_approval_request.jsonl`
 */
export function detectPermissionGate(
  payload: Record<string, unknown>,
  provider: ProviderId | undefined
): PermissionGateInfo | null {
  if (provider !== "codex") {
    if (stringValue(payload.type) === "system" && stringValue(payload.subtype) === "permission_denied") {
      const tool = stringValue(payload.tool_name) ?? "tool";
      const reason =
        stringValue(payload.decision_reason) ?? stringValue(payload.message) ?? "permission denied";
      return {
        command: tool,
        reason,
        riskLevel: classifyToolRisk(tool),
        ...(stringValue(payload.tool_use_id) ? { toolUseId: stringValue(payload.tool_use_id) as string } : {})
      };
    }
  }

  if (provider !== "claude") {
    const method = stringValue(payload.method);
    if (
      method &&
      (method.endsWith("/requestApproval") ||
        method === "applyPatchApproval" ||
        method === "execCommandApproval")
    ) {
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
        riskLevel: isFileChange ? "high" : classifyCommandRisk(command)
      };
    }
  }

  return null;
}

const HIGH_RISK_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const HIGH_RISK_COMMAND_RE = /\b(rm\b|sudo\b|dd\b|mkfs|chmod\s+0?7|chown\s)/i;

function classifyToolRisk(tool: string): "low" | "medium" | "high" {
  if (HIGH_RISK_TOOLS.has(tool)) return "high";
  return "medium";
}

function classifyCommandRisk(command: string): "low" | "medium" | "high" {
  if (HIGH_RISK_COMMAND_RE.test(command)) return "high";
  return "medium";
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractCodexTurnContextModel(payload: Record<string, unknown>): string | null {
  // Codex turn_context rows usually carry the model on `payload.model`.
  // Some variants nest it inside `payload.payload.model`.
  return (
    stringValue(payload.model) ??
    stringValue(objectValue(payload.payload)?.model) ??
    null
  );
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
  return null;
}

function extractClaudeUsage(
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

function extractCodexUsage(
  payload: Record<string, unknown>,
  providerType: string | null,
  context: NormalizerSessionContext | undefined
): NormalizedUsage | null {
  // Codex emits token usage two ways:
  //   1. Outer `{type:"event_msg", payload:{type:"token_count", info:{last_token_usage:{...}}}}`
  //   2. Outer `{type:"token_count", info:{last_token_usage:{...}}}` (flattened)
  let info: Record<string, unknown> | null = null;

  if (providerType === "event_msg") {
    const inner = objectValue(payload.payload);
    if (inner && stringValue(inner.type) === "token_count") {
      info = objectValue(inner.info);
    }
  } else if (providerType === "token_count") {
    info = objectValue(payload.info);
  }

  if (!info) return null;
  const last = objectValue(info.last_token_usage);
  if (!last) return null;

  const inputTokens = numberValue(last.input_tokens);
  const cachedInput = numberValue(last.cached_input_tokens);
  const outputTokens = numberValue(last.output_tokens);
  if (inputTokens + outputTokens + cachedInput === 0) return null;

  // OpenAI reports `input_tokens` as the full context size INCLUDING cached
  // tokens. Subtract so the cost calculator does not double-bill cache reads.
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
