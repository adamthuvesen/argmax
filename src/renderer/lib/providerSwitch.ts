import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

/**
 * Handing an idle session to another provider. The new agent can't resume the
 * old one's native conversation, so `send_input` drops the resume id and
 * relaunches from the visible transcript (providers/follow_up.rs). That is a
 * real seam in the conversation — the chat shows it for the same reason it
 * shows a compaction: everything after it was written by an agent that only
 * read a summary of everything before it.
 */
export interface ProviderSwitchNotice {
  /** Absent on rows written before the payload carried both ends. */
  from: string | null;
  to: string;
  modelLabel: string | null;
}

export function providerSwitchNoticeFor(event: TimelineEvent): ProviderSwitchNotice {
  const canonical = decodeTimelineEvent(event);
  if (canonical.kind !== "lifecycle" || canonical.name !== "provider-changed") {
    return { from: null, to: event.message, modelLabel: null };
  }
  return {
    from: canonical.from,
    to: canonical.to,
    modelLabel: canonical.modelLabel
  };
}
