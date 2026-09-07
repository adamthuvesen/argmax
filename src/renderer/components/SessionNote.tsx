import type { JSX } from "react";

/**
 * A line Argmax wrote into the chat about the chat itself — resuming a move or
 * archive it promised before the last quit, or dropping one the turn never
 * earned. It reports, it does not fail: a failure keeps the rose log block, and
 * a note that borrowed that shape read as something to act on. Quieter than the
 * seam notices too, because nothing changed hands here.
 */
export function SessionNote({ message }: { message: string }): JSX.Element {
  return (
    <div className="conversation-note" role="status" aria-live="polite">
      <span className="conversation-note-text">{message}</span>
    </div>
  );
}
