import { randomUUID } from "node:crypto";
import type { PersistTimelineEventInput } from "../persistence/database.js";
import type { EventType } from "../../shared/types.js";
import type { ProviderEvent } from "./providerTypes.js";

export function normalizeProviderEvent(event: ProviderEvent): PersistTimelineEventInput[] {
  if (event.type !== "output") {
    return [];
  }

  const jsonEvents = parseJsonLines(event.message)
    .map((payload) => normalizeJsonPayload(event, payload))
    .filter((item): item is PersistTimelineEventInput => Boolean(item));

  if (jsonEvents.length > 0) {
    return jsonEvents;
  }

  const message = event.message.trim();
  return [
    {
      id: randomUUID(),
      sessionId: event.sessionId,
      type: event.stream === "stderr" ? "error" : "message.delta",
      message: message || "Unparsed provider output",
      payload: {
        raw: true,
        stream: event.stream
      },
      createdAt: event.createdAt
    }
  ];
}

function parseJsonLines(value: string): Record<string, unknown>[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function normalizeJsonPayload(
  event: ProviderEvent,
  payload: Record<string, unknown>
): PersistTimelineEventInput | null {
  const providerType = stringValue(payload.type);
  const item = objectValue(payload.item);
  const itemType = stringValue(item?.type);
  const text = stringValue(item?.text) ?? stringValue(payload.text) ?? stringValue(payload.message);
  const mappedType = mapProviderType(providerType, itemType);

  if (!mappedType && !text) {
    return null;
  }

  return {
    id: randomUUID(),
    sessionId: event.sessionId,
    type: mappedType ?? "message.delta",
    message: text ?? providerType ?? "Provider event",
    payload,
    createdAt: event.createdAt
  };
}

function mapProviderType(providerType: string | null, itemType: string | null): EventType | null {
  if (itemType === "agent_message" || providerType === "message.completed") {
    return "message.completed";
  }

  if (!providerType) {
    return null;
  }

  if (providerType.includes("command.started")) {
    return "command.started";
  }
  if (providerType.includes("command.output")) {
    return "command.output";
  }
  if (providerType.includes("command.completed")) {
    return "command.completed";
  }
  if (providerType.includes("approval.requested")) {
    return "approval.requested";
  }
  if (providerType.includes("approval.resolved")) {
    return "approval.resolved";
  }
  if (providerType.includes("file.changed")) {
    return "file.changed";
  }
  if (providerType.includes("check.started")) {
    return "check.started";
  }
  if (providerType.includes("check.completed")) {
    return "check.completed";
  }
  if (providerType.includes("error")) {
    return "error";
  }
  if (providerType.includes("completed")) {
    return "message.completed";
  }
  if (providerType.includes("delta")) {
    return "message.delta";
  }

  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
