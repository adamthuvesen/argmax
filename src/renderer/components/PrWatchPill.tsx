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
export function PrWatchPill({
  prs,
  chatFontSize
}: {
  prs: readonly SessionPrSummary[];
  /** The composer's type scale, so the pill sizes with its chips. */
  chatFontSize?: number;
}): JSX.Element | null {
  const watched = prs.filter((pr) => pr.isWatched && pr.prState === "OPEN");
  if (watched.length === 0) return null;
  return (
    <div
      className="pr-watch-pills"
      data-font-size={chatFontSize === undefined ? undefined : String(chatFontSize)}
      data-type-scale={chatFontSize === undefined ? "composer" : undefined}
    >
      {watched.map((pr) => (
        <button
          key={pr.prNumber}
          type="button"
          className="pr-watch-pill"
          disabled={!pr.url}
          title={pr.title ? `Babysitting PR #${pr.prNumber}: ${pr.title}` : `Babysitting PR #${pr.prNumber}`}
          onClick={(event) => {
            if (pr.url) openWebUrl(pr.url, { flip: event.metaKey || event.ctrlKey });
          }}
        >
          <Eye size={13} aria-hidden="true" />
          Babysitting PR #{pr.prNumber}
        </button>
      ))}
    </div>
  );
}
