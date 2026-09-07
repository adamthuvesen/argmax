import { recordRendererLog } from "./rendererLogRing.js";

// Breadcrumbs for the chat's progress cue.
//
// The "Thinking" line is the only thing on screen during the ten to thirty
// seconds a relaunched provider takes to say its first word, and it is derived
// from half a dozen suppression rules. When it fails to appear, the pane is
// black and the transcript records nothing about why — the state that decided
// it is gone by the time anyone looks. One line per transition makes the next
// occurrence a single lookup instead of an archaeology session.

/** Why the cue is not on screen while the session is live. `shown` is the
 *  cue's own state, not a suppressor. */
export type ChatCueReason =
  | "shown"
  | "show-delay"
  | "tool-running"
  | "card-ask"
  | "live-thought"
  | "streaming-text"
  | "answer-settling"
  | "compacting";

const SCOPE = "renderer::chat";

export function recordChatCue(input: {
  sessionId: string;
  provider: string | null;
  visible: boolean;
  reason: ChatCueReason;
}): void {
  recordRendererLog({
    scope: SCOPE,
    message: input.visible ? "progress cue shown" : "progress cue hidden",
    fields: {
      sessionId: input.sessionId,
      reason: input.reason,
      ...(input.provider === null ? {} : { provider: input.provider })
    }
  });
}
