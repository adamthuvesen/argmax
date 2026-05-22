import type { EventType } from "../../../shared/types.js";

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isLifecycleEvent(providerType: string | null, itemType: string | null): boolean {
  return (
    itemType !== "agent_message" &&
    (providerType === "thread.started" ||
      providerType === "turn.started" ||
      providerType === "turn.completed" ||
      providerType === "session.started")
  );
}

export function isMessageEvent(eventType: EventType | null): boolean {
  return eventType === "message.delta" || eventType === "message.completed";
}

const HIGH_RISK_COMMAND_RE = /\b(rm\b|sudo\b|dd\b|mkfs|chmod\s+0?7|chown\s)/i;

export function classifyCommandRisk(command: string): "low" | "medium" | "high" {
  if (HIGH_RISK_COMMAND_RE.test(command)) return "high";
  return "medium";
}
