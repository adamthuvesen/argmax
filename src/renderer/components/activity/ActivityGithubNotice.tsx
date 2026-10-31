import type { JSX } from "react";
import type { ActivityGithubState } from "./activityContract.js";

/**
 * What the two GitHub cards show instead of their contents when `gh` cannot
 * answer. Only those two cards fail: commits, lines, streaks and cadence are
 * read straight out of the local clones, so a signed-out `gh` costs the page
 * two panels rather than the page.
 *
 * The error is the tool's own words, then the one action that fixes the usual
 * cause. Shared by both cards so the sentence cannot drift between them.
 */
export function ActivityGithubNotice({ github }: { github: ActivityGithubState }): JSX.Element {
  return (
    <div className="activity-notice" data-tone="quiet" role="status">
      <p className="activity-notice-line">
        {github.error ?? "GitHub is not reachable, so pull requests and reviews are unavailable."}
      </p>
      <p className="activity-notice-hint">
        Run <code>gh auth login</code> to bring this card back. Commits, lines and streaks come from
        your local clones and are unaffected.
      </p>
    </div>
  );
}
