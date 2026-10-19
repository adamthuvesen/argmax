import { useEffect, useState, type JSX } from "react";
import { GitFork } from "lucide-react";
import type { ForkLineage } from "../../shared/types.js";
import { useForkBarVisible } from "../lib/forkBarVisibility.js";
import { ForkMergeDialog } from "./ForkMergeDialog.js";

/**
 * Marks a chat that was forked from another and offers the way back: open the
 * source, or bring this fork's findings to it. A chat that was not forked
 * renders nothing, and so does a host without the fork channels or a user who
 * turned the bar off in Settings → Appearance.
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
  const visible = useForkBarVisible();

  useEffect(() => {
    let cancelled = false;
    setLineage(null);
    setMerging(false);
    if (!visible) return;
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
  }, [sessionId, visible]);

  if (!visible || !lineage) return null;
  const sourceSessionId = lineage.sourceSessionId;
  const sourceLabel = lineage.sourceLabel ?? "the source chat";
  return (
    <div className="fork-bar" role="region" aria-label="Forked chat">
      <GitFork size={12} aria-hidden />
      <span className="fork-bar-label">
        {sourceSessionId ? (
          <>
            Forked from{" "}
            {onOpenSession ? (
              <button
                className="fork-bar-source"
                type="button"
                title="Open source chat"
                onClick={() => onOpenSession(sourceSessionId)}
              >
                {sourceLabel}
              </button>
            ) : (
              <span className="fork-bar-source">{sourceLabel}</span>
            )}
          </>
        ) : (
          "Forked from a deleted chat"
        )}
        {lineage.workspace === "isolated" ? " · isolated checkout" : ""}
      </span>
      {/* A deleted source has nothing to receive findings. */}
      {sourceSessionId ? (
        <button className="fork-bar-return" type="button" onClick={() => setMerging(true)}>
          Bring findings back
        </button>
      ) : null}
      {merging ? (
        <ForkMergeDialog childSessionId={sessionId} onClose={() => setMerging(false)} />
      ) : null}
    </div>
  );
}
