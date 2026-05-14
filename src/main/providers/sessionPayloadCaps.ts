import { randomUUID } from "node:crypto";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import type { PersistTimelineEventInput } from "../persistence/database.js";
import type { ProviderId, TimelineEvent } from "../../shared/types.js";
import type { ProviderEvent } from "./providerTypes.js";

/** 256 KB cap on raw_outputs.content per row. */
export const RAW_OUTPUT_CAP = 256 * 1024;
/** 64 KB cap on per-event payload_json. */
export const EVENT_PAYLOAD_CAP = 64 * 1024;
/** Truncated-payload preview slice (kept inline on the original event). */
const EVENT_PAYLOAD_PREVIEW = 4 * 1024;

/**
 * Cap raw stdout/stderr content to `RAW_OUTPUT_CAP` bytes. Appends a literal
 * truncation marker so the renderer can show the user that bytes were dropped.
 */
export function capRawContent(content: string): { content: string; droppedBytes: number } {
  if (content.length <= RAW_OUTPUT_CAP) {
    return { content, droppedBytes: 0 };
  }
  const droppedBytes = content.length - RAW_OUTPUT_CAP;
  return {
    content: `${content.slice(0, RAW_OUTPUT_CAP)}[truncated ${droppedBytes} bytes]`,
    droppedBytes
  };
}

/**
 * For an oversized provider event, emit a `message.delta` sidecar so the
 * truncation is visible in the timeline. Returns `null` if the event fits
 * within the cap.
 */
export function capRawTruncationMarker(event: ProviderEvent): PersistTimelineEventInput | null {
  if (event.message.length <= RAW_OUTPUT_CAP) {
    return null;
  }
  const droppedBytes = event.message.length - RAW_OUTPUT_CAP;
  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: "message.delta",
    message: `Output truncated: ${droppedBytes} bytes dropped`,
    payload: {
      truncated: true,
      droppedBytes,
      stream: event.stream
    },
    createdAt: event.createdAt
  };
}

/**
 * Sniff Codex / Cursor structured-JSON output for the provider's session id.
 * Codex emits `{type:"thread.started", thread_id:"<id>"}`; Cursor emits
 * `{type:"system", subtype:"init", session_id:"<uuid>"}` once at the start.
 * Returns null for other providers or when no match is found.
 */
export function extractProviderConversationId(content: string, provider: ProviderId): string | null {
  if (provider !== "codex" && provider !== "cursor") {
    return null;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const record = tryParseJsonObject(rawLine.trim());
    if (!record) {
      continue;
    }
    if (
      provider === "codex" &&
      record.type === "thread.started" &&
      typeof record.thread_id === "string" &&
      record.thread_id.length > 0
    ) {
      return record.thread_id;
    }
    if (
      provider === "cursor" &&
      record.type === "system" &&
      record.subtype === "init" &&
      typeof record.session_id === "string" &&
      record.session_id.length > 0
    ) {
      return record.session_id;
    }
  }

  return null;
}

interface CappedPayload {
  payload: Record<string, unknown>;
  sibling: Omit<PersistTimelineEventInput, "sessionId"> | null;
}

// Keys that must survive truncation so downstream consumers (renderer, tests)
// can still reconcile state. For command.completed especially: without
// tool_use_id/id the renderer can't match the result back to its
// command.started event, and the tool call hangs in "running" forever.
const STRUCTURAL_KEYS_BY_TYPE: Partial<Record<TimelineEvent["type"], readonly string[]>> = {
  "command.started": ["id", "call_id", "tool_use_id", "name", "type"],
  "command.completed": [
    "id",
    "call_id",
    "tool_use_id",
    "name",
    "type",
    "is_error",
    "isError",
    "status"
  ]
};

/**
 * Apply the `EVENT_PAYLOAD_CAP` payload size limit. For oversized events,
 * returns a truncated payload (with structural keys preserved per the event
 * type's `STRUCTURAL_KEYS_BY_TYPE` allowlist) plus a sibling `error` event
 * that documents the truncation in the timeline.
 */
export function capEventPayload(
  payload: Record<string, unknown>,
  eventType?: string
): CappedPayload {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { payload: { truncated: true, originalSize: 0, preview: "" }, sibling: null };
  }
  if (serialized.length <= EVENT_PAYLOAD_CAP) {
    return { payload, sibling: null };
  }
  const truncatedEventId = randomUUID();
  const preserved: Record<string, unknown> = {};
  const preserveKeys = (eventType && STRUCTURAL_KEYS_BY_TYPE[eventType as TimelineEvent["type"]]) ?? [];
  for (const key of preserveKeys) {
    if (key in payload) preserved[key] = payload[key];
  }
  return {
    payload: {
      ...preserved,
      truncated: true,
      originalSize: serialized.length,
      preview: serialized.slice(0, EVENT_PAYLOAD_PREVIEW),
      truncatedEventId
    },
    sibling: {
      id: randomUUID(),
      type: "error",
      message: "event payload truncated",
      payload: {
        truncatedEventId,
        originalSize: serialized.length
      }
    }
  };
}
