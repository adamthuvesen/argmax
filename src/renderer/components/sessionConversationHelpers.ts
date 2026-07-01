import type { AgentMode } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import type { RenderItem } from "../lib/foldConversation.js";
import type { ModelPickerSelection } from "../lib/models.js";

export type UserMessageAttachment = {
  filePath: string;
  mimeType: string;
};

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

export function parseUserMessageAttachments(
  item: Extract<RenderItem, { kind: "user-message" }>
): UserMessageAttachment[] {
  const rawAttachments = arrayValue(item.event.payload.attachments) ?? [];
  return rawAttachments
    .map((entry) => {
      const obj = objectValue(entry);
      const filePath = stringValue(obj?.filePath);
      const mimeType = stringValue(obj?.mimeType);
      if (!filePath || !mimeType) return null;
      return { filePath, mimeType };
    })
    .filter((value): value is UserMessageAttachment => Boolean(value));
}

export type SessionConversationSendInput = (
  sessionId: string,
  input: string,
  model: ModelPickerSelection,
  agentMode: AgentMode
) => Promise<void>;
