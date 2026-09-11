import type { JSX } from "react";
import type { ActivityPullRequest, ActivitySummary } from "./activityContract.js";
import {
  formatAdded,
  formatCount,
  formatDuration,
  formatRemoved,
  formatShortDate
} from "./activityFormat.js";
import { repositorySlots } from "./activityPresentation.js";
import { ActivityGithubNotice } from "./ActivityGithubNotice.js";

/**
 * The window's pull requests as a ledger: what shipped, out of which
 * repository, how long it sat, and how big it was. Cycle time is opened →
 * merged, which is the number a reader can act on — a PR that took four days
 * is a review-queue problem, and one that took four minutes was not reviewed.
 */

/** Rows before the ledger is cut; the footer says how many there are in all. */
const VISIBLE_ROWS = 8;

const STATE_TITLE: Record<ActivityPullRequest["state"], string> = {
  merged: "Merged",
  open: "Open",
  closed: "Closed without merging"
};

/**
 * `Sep 1 → Sep 2`, `Sep 2 → open`, `Aug 22 → closed Aug 24`. One cell, because
 * "when did this start and when did it land" is one question.
 */
function transition(pr: ActivityPullRequest, timeZone: string): JSX.Element {
  return (
    <>
      {formatShortDate(pr.createdAt, timeZone)}
      <span className="activity-arrow" aria-hidden="true">
        →
      </span>
      {pr.state === "merged" ? (
        formatShortDate(pr.mergedAt, timeZone)
      ) : pr.state === "closed" ? (
        <span className="activity-pr-quiet">closed {formatShortDate(pr.closedAt, timeZone)}</span>
      ) : (
        <span className="activity-pr-quiet">open</span>
      )}
    </>
  );
}

/** How long it took, or how long it has been waiting. */
function cycle(pr: ActivityPullRequest, now: number): JSX.Element {
  if (pr.state === "merged" && pr.cycleSeconds !== null) {
    return <>{formatDuration(pr.cycleSeconds)}</>;
  }
  if (pr.state === "open") {
    const waiting = (now - new Date(pr.createdAt).getTime()) / 1000;
    return (
      <span className="activity-pr-quiet">
        {waiting > 0 ? `${formatDuration(waiting)} so far` : "just opened"}
      </span>
    );
  }
  return (
    <span className="activity-pr-quiet" aria-label="no cycle time">
      —
    </span>
  );
}

export function ActivityPullRequests({ summary }: { summary: ActivitySummary }): JSX.Element {
  const { totals, github } = summary;
  // Every window ends at the present, so "3h so far" is measured from the
  // window's own end rather than from the wall clock — which also keeps the
  // fixture's pinned clock out of the figure.
  const now = new Date(summary.rangeEnd).getTime();
  const slots = repositorySlots(summary.repositories);
  const rows = summary.pullRequests.slice(0, VISIBLE_ROWS);
  // Counted off the list rather than from `totals`: `prsOpened` counts what
  // was *created* in the window and `prsMerged` what *merged* in it, so
  // subtracting one from the other double-counts every PR that crossed the
  // window's edge.
  const stillOpen = summary.pullRequests.filter((pr) => pr.state === "open").length;

  return (
    <section className="activity-card activity-pr-card" aria-label="Pull requests">
      <div className="activity-card-head">
        <h2 className="activity-card-title">Pull requests</h2>
        {github.available ? (
          <p className="activity-card-note">
            <strong>{formatCount(totals.prsMerged)}</strong> merged ·{" "}
            <strong>{formatCount(stillOpen)}</strong> open ·{" "}
            <strong>{formatCount(totals.prsClosed)}</strong> closed
          </p>
        ) : null}
      </div>

      {!github.available ? (
        <ActivityGithubNotice github={github} />
      ) : rows.length === 0 ? (
        <p className="activity-empty-note">No pull request opened or merged in this window.</p>
      ) : (
        <>
          <table className="activity-ledger" aria-label="Pull requests you authored">
            <colgroup>
              <col />
              <col className="activity-ledger-col-repo" />
              <col className="activity-ledger-col-dates" />
              <col className="activity-ledger-col-cycle" />
              <col className="activity-ledger-col-lines" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Repository</th>
                <th scope="col">Opened → merged</th>
                <th scope="col" className="activity-num">
                  Cycle
                </th>
                <th scope="col" className="activity-num">
                  Lines
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((pr) => (
                <tr key={`${pr.repository}#${pr.number}`}>
                  <th scope="row">
                    <span className="activity-pr-title">
                      {/* The state is a dot rather than a word: the column is
                          the title's, and three states read faster as violet /
                          sage / an empty ring than as three more labels. The
                          `title` carries the word for a reader who needs it. */}
                      <span
                        className="activity-pr-state"
                        data-state={pr.state}
                        title={STATE_TITLE[pr.state]}
                      />
                      <span className="activity-pr-label">{pr.title}</span>
                      {pr.isDraft ? <span className="activity-pr-draft">Draft</span> : null}
                    </span>
                  </th>
                  <td>
                    <span
                      className="activity-repo-chip activity-series"
                      data-slot={pr.projectId ? (slots.get(pr.projectId) ?? "tail") : "tail"}
                    >
                      <span className="activity-series-dot" aria-hidden="true" />
                      {pr.repository.split("/").pop()}
                    </span>
                  </td>
                  <td>{transition(pr, summary.timeZone)}</td>
                  <td className="activity-num">{cycle(pr, now)}</td>
                  <td className="activity-num">
                    <span className="activity-plus">{formatAdded(pr.additions)}</span>{" "}
                    <span className="activity-minus">{formatRemoved(pr.deletions)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="activity-ledger-foot">
            {/* The median is in the hero's stat list, so the footer spends
                itself on the definition instead of repeating the figure. */}
            <span>Cycle time is opened → merged, over pull requests you authored.</span>
            {summary.pullRequests.length > rows.length ? (
              <span className="activity-ledger-more">
                {formatCount(summary.pullRequests.length)} in this window
              </span>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}
