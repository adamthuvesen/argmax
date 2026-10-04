import { useEffect, useState, type JSX } from "react";
import { GitFork } from "lucide-react";
import type { ForkLineage } from "../../shared/types.js";
import { ForkMergeDialog } from "./ForkMergeDialog.js";

/**
 * Marks a chat that was forked from another and offers the way back: open the
 * source, or bring this fork's findings to it. A chat that was not forked
 * renders nothing, and so does a host without the fork channels.
 *
 * The fork has no provider conversation until its first message. The composer's
 * agent picker chooses the provider then; see docs/providers.md.
 */
export function ForkBar({
  sessionId,
  onOpenSession
}: {
  sessionId: string;
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element | null {
  const [lineage, setLineage] = useState<ForkLineage | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLineage(null);
    setMerging(false);
    // Optional all the way down: a host (or a test stub) that predates the fork
    // channels simply has no lineage to show.
    void window.argmax?.session?.forkLineage?.({ sessionId })
      .then((next) => {
        if (!cancelled) setLineage(next);
      })
      .catch(() => {
        // A chat that cannot report its lineage is just an ordinary chat.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!lineage) return null;
  return (
    <div className="fork-bar" role="region" aria-label="Forked chat">
      <GitFork size={13} aria-hidden />
      <span className="fork-bar-label">
        Forked chat{lineage.workspace === "isolated" ? " in an isolated checkout" : ""}
      </span>
      <span className="fork-bar-actions">
        {onOpenSession && lineage.sourceSessionId ? (
          <button type="button" onClick={() => onOpenSession(lineage.sourceSessionId!)}>
            Open source
          </button>
        ) : null}
        {/* A deleted source has nothing to receive findings. */}
        {lineage.sourceSessionId ? (
          <button type="button" onClick={() => setMerging(true)}>
            Bring findings back
          </button>
        ) : null}
      </span>
      {merging ? (
        <ForkMergeDialog childSessionId={sessionId} onClose={() => setMerging(false)} />
      ) : null}
    </div>
  );
}
