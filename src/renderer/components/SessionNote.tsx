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
  const cloudLink = /^Sent task to Claude Cloud: (https:\/\/claude\.ai\/code\/(?:session|cse)_[A-Za-z0-9_-]+)$/.exec(message)?.[1];
  return (
    <div className="conversation-note" role="status" aria-live="polite">
      <span className="conversation-note-text">
        {cloudLink ? <>Sent task to Claude Cloud · <WebLink href={cloudLink}>Open cloud session</WebLink></> : message}
      </span>
    </div>
  );
}
