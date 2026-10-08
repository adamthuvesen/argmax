import type { JSX } from "react";
import { Eye } from "lucide-react";
import type { SessionPrSummary } from "../../shared/types.js";
import { openWebUrl } from "../lib/openWebUrl.js";

/**
 * Sits on top of the composer while this chat watches an open PR: Argmax
 * wakes the agent when the PR changes, so the user can see the babysit is on
 * without the notices taking up the chat. The phone draws its PR pill in the
 * same place.
 */
export function PrWatchPill({ prs }: { prs: readonly SessionPrSummary[] }): JSX.Element | null {
  const watched = prs.filter((pr) => pr.isWatched && pr.prState === "OPEN");
  if (watched.length === 0) return null;
  return (
    <div className="pr-watch-pills">
      {watched.map((pr) => (
        <button
          key={pr.prNumber}
          type="button"
          className="pr-watch-pill"
          disabled={!pr.url}
          title={pr.title ? `Watching PR #${pr.prNumber}: ${pr.title}` : `Watching PR #${pr.prNumber}`}
          onClick={(event) => {
            if (pr.url) openWebUrl(pr.url, { flip: event.metaKey || event.ctrlKey });
          }}
        >
          <Eye size={13} aria-hidden="true" />
          Watching PR #{pr.prNumber}
        </button>
      ))}
    </div>
  );
}
