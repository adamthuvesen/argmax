import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type { AgentMode, TimelineEvent } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import type { RenderItem } from "../lib/foldConversation.js";

/**
 * Terminate a running probe (if needed) then send follow-up input. Surfaces
 * errors via `onError` and resolves to `false` on failure so optimistic callers
 * (Plan/Question cards) can roll back their "submitted" state.
 */
export async function sendAfterTerminate(
  sessionId: string,
  isRunning: boolean,
  onTerminateSession: (id: string) => Promise<void>,
  send: () => Promise<void>,
  onError: (message: string) => void
): Promise<boolean> {
  if (isRunning) {
    try {
      await onTerminateSession(sessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not terminate session.");
      return false;
    }
  }
  try {
    await send();
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : "Could not send input.");
    return false;
  }
}

export function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

export function isSubAgentProseEcho(event: TimelineEvent): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed") return false;
  const parentToolUseId = event.payload.parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
}

export function parseUserMessageAttachments(
  item: Extract<RenderItem, { kind: "user-message" }>
): { filePath: string; mimeType: string }[] {
  const rawAttachments = arrayValue(item.event.payload.attachments) ?? [];
  return rawAttachments
    .map((entry) => {
      const obj = objectValue(entry);
      const filePath = stringValue(obj?.filePath);
      const mimeType = stringValue(obj?.mimeType);
      if (!filePath || !mimeType) return null;
      return { filePath, mimeType };
    })
    .filter((value): value is { filePath: string; mimeType: string } => Boolean(value));
}

export type SessionConversationSendInput = (
  sessionId: string,
  input: string,
  model: ProviderModelSelection,
  agentMode: AgentMode
) => Promise<void>;
