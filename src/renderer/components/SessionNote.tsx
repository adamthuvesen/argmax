import type { JSX } from "react";
import type { ProjectSourceActivity } from "../lib/canonicalTimeline.js";
import { SourceActivity } from "./SourceActivity.js";
import { WebLink } from "./WebLink.js";

/**
 * A line Argmax wrote into the chat about the chat itself — resuming a move or
 * archive it promised before the last quit, or dropping one the turn never
 * earned. It reports, it does not fail: a failure keeps the rose log block, and
 * a note that borrowed that shape read as something to act on. Quieter than the
 * seam notices too, because nothing changed hands here.
 */
export function SessionNote({ message, sourceActivity }: { message: string; sourceActivity?: ProjectSourceActivity }): JSX.Element {
  if (sourceActivity) return <SourceActivity activity={sourceActivity} />;
  const cloudHandoff = CLOUD_HANDOFF_NOTE.exec(message);
  return (
    <div className="conversation-note" role="status" aria-live="polite">
      <span className="conversation-note-text">
        {cloudHandoff
          ? <>Sent task to {cloudHandoff[1]} Cloud · <WebLink href={cloudHandoff[2]}>Open task</WebLink></>
          : message}
      </span>
    </div>
  );
}

/** The note Rust writes after a cloud launch (`handoff_note` in
 *  providers/cloud.rs). Only each provider's own task URL shape becomes a
 *  link; anything else stays plain text. */
const CLOUD_HANDOFF_NOTE =
  /^Sent task to (Claude|Codex|Cursor) Cloud: (https:\/\/(?:claude\.ai\/code\/(?:session|cse)_|chatgpt\.com\/codex\/tasks\/task_|cursor\.com\/agents\/)[A-Za-z0-9_-]+)$/;
