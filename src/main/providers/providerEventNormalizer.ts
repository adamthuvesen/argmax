/**
 * Architectural decision — 2026-05-14 quality sweep (Ralph SPEC D4).
 *
 * This file is 800+ lines because it dispatches over three provider event
 * shapes (Claude, Codex, Cursor) plus shared usage normalization. Splitting
 * into per-provider files was considered and deferred:
 *
 * - The dispatcher's runtime cost is one switch over `provider`; a multi-file
 *   layout adds an indirection per event for negligible readability gain.
 * - The dispatcher closures share session context (`NormalizerSessionContext`)
 *   that would have to thread through three module boundaries instead of one.
 * - Cursor's stream-json shape is still stabilizing; per-provider splits made
 *   *now* would lock in a layout that may need to re-merge once we know the
 *   final boundaries.
 *
 * Revisit once Cursor support is stable and per-provider normalizer changes
 * collide with each other on review — until then, keep this file unified.
 */

import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../persistence/database.js";
import type { EventType, ProviderId } from "../../shared/types.js";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import { stripTerminalControls } from "../../shared/terminalControls.js";
import { costOf, type UsageCounts } from "../../shared/providerModels.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import type { ProviderEvent } from "./providerTypes.js";

export interface NormalizerSessionContext {
  /** Most-recent Codex `turn_context.model` seen for this session. */
  codexCurrentModel: string | null;
  /**
   * Model id passed to `--model` when launching the cursor session. Cursor's
   * stream-json reports `model` as a display name on `system/init` and not at
   * all on `result/success`, so we thread the canonical id through from launch
   * to feed `costOf()` when usage arrives.
   */
  cursorCurrentModel: string | null;
  /**
   * Cursor's `--stream-partial-output` emits each `assistant` row as a
   * *cumulative snapshot* of the message so far, not an incremental chunk.
   * We track the most recent snapshot per turn so we can derive a true
   * suffix-only delta — otherwise the renderer's chunk concatenation
   * produces "ExplExploring the repository..." style duplication.
   * Reset to `null` when the final cumulative row (no timestamp_ms) lands
   * as `message.completed`, signalling end of turn.
   */
  cursorAssistantText: string | null;
}

export function createNormalizerSessionContext(
  initial: { codexCurrentModel?: string; cursorCurrentModel?: string } = {}
): NormalizerSessionContext {
  return {
    codexCurrentModel: initial.codexCurrentModel ?? null,
    cursorCurrentModel: initial.cursorCurrentModel ?? null,
    cursorAssistantText: null
  };
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
  const rawText = extractMessageText(payload, item);
  const text = normalizeCursorAssistantText(rawText, payload, providerType, provider, context);

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

  if (provider === "cursor" && isCursorLifecycleEvent(providerType, stringValue(payload.subtype))) {
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
        ...(gate.cwd ? { cwd: gate.cwd } : {}),
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

  const mappedType = mapProviderType(providerType, itemType, provider, payload);

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
function normalizeCursorAssistantText(
  text: string | null,
  payload: Record<string, unknown>,
  providerType: string | null,
  provider: ProviderId | undefined,
  context: NormalizerSessionContext | undefined
): string | null {
  if (provider !== "cursor" || !context || providerType !== "assistant" || text === null) {
    return text;
  }
  const hasTimestamp = typeof payload.timestamp_ms === "number";
  if (!hasTimestamp) {
    // Final cumulative row → message.completed. Emit full text, reset state
    // so the next turn's partials start fresh.
    context.cursorAssistantText = null;
    return text;
  }
  const prior = context.cursorAssistantText ?? "";
  context.cursorAssistantText = text;
  // Defensive: if Cursor ever emits a delta that *doesn't* extend the prior
  // snapshot (truncation, model retry, etc.), fall back to the full text so
  // we don't drop content. The renderer's coalesced bubble will reset on the
  // next message.completed.
  return text.startsWith(prior) ? text.slice(prior.length) : text;
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
// extractor). `user`, `thinking`, `system/init`, and `result/success` are
// suppressed earlier by isCursorLifecycleEvent — they do not appear here.
// `tool_call` rows are routed by normalizeCursorToolCall.
// `assistant` itself is routed in mapProviderType using the timestamp_ms
// signal — partial chunks become message.delta, the final cumulative row
// becomes message.completed.
const cursorEventMap: Record<string, EventType> = {
  error: "error"
};

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
      // With --stream-partial-output, every chunk has timestamp_ms; only the
      // final cumulative `assistant` row (emitted right before result/success)
      // lacks it. Treat partials as deltas so the renderer can coalesce them
      // into a single growing bubble; treat the final row as the completed
      // message so it can replace the running deltas cleanly.
      const hasTimestamp = payload !== undefined && typeof payload.timestamp_ms === "number";
      return hasTimestamp ? "message.delta" : "message.completed";
    }
    return cursorEventMap[providerType] ?? null;
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
function isCursorLifecycleEvent(providerType: string | null, subtype: string | null): boolean {
  if (providerType === "system" && subtype === "init") return true;
  if (providerType === "result" && subtype === "success") return true;
  if (providerType === "user") return true;
  if (providerType === "thinking") return true;
  return false;
}

interface PermissionGateInfo {
  command: string;
  reason: string;
  riskLevel: "low" | "medium" | "high";
  cwd?: string;
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
        riskLevel: isFileChange ? "high" : classifyCommandRisk(command),
        ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) as string } : {})
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
  if (provider === "cursor") {
    return extractCursorUsage(payload, providerType, context);
  }
  return null;
}

function extractCursorUsage(
  payload: Record<string, unknown>,
  providerType: string | null,
  context: NormalizerSessionContext | undefined
): NormalizedUsage | null {
  // Cursor only reports usage on the `result/success` row at end of turn.
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
  // Cursor proxies multiple model families and bills per-request, not per-token.
  // We surface token counts for visibility and let costOf() return $0 for
  // unknown ids — a misleading API-price would be worse than no price.
  const modelId = context?.cursorCurrentModel ?? "cursor-unknown";
  return {
    modelId,
    tokens,
    costUsd: costOf(tokens, modelId)
  };
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
  // Codex emits token usage a few ways:
  //   1. Outer `{type:"event_msg", payload:{type:"token_count", info:{last_token_usage:{...}}}}`
  //   2. Outer `{type:"token_count", info:{last_token_usage:{...}}}` (flattened)
  //   3. Current JSONL `{type:"turn.completed", usage:{...}}`
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
