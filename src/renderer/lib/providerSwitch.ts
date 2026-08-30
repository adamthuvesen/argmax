import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type { EventType, ProviderId, TimelineEvent } from "../../shared/types.js";

/**
 * Handing an idle session to another provider. The new agent can't resume the
 * old one's native conversation, so `send_input` drops the resume id and
 * relaunches from the visible transcript (providers/follow_up.rs). That is a
 * real seam in the conversation — the chat shows it for the same reason it
 * shows a compaction: everything after it was written by an agent that only
 * read a summary of everything before it.
 */
export const PROVIDER_CHANGED: EventType = "session.provider-changed";

export interface ProviderSwitchNotice {
  /** Absent on rows written before the payload carried both ends. */
  from: string | null;
  to: string;
  modelLabel: string | null;
}

export function isProviderSwitchEvent(event: TimelineEvent): boolean {
  return event.type === PROVIDER_CHANGED;
}

function providerName(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return PROVIDER_DISPLAY_NAMES[value as ProviderId] ?? value;
}

export function providerSwitchNoticeFor(event: TimelineEvent): ProviderSwitchNotice {
  const modelLabel = event.payload.modelLabel;
  return {
    from: providerName(event.payload.from),
    // The message ("Switched provider to X.") is the fallback for a row whose
    // payload predates these fields.
    to: providerName(event.payload.provider) ?? event.message,
    modelLabel: typeof modelLabel === "string" && modelLabel !== "" ? modelLabel : null
  };
}
