import type { JSX } from "react";
import type { ActivityReviewState, ActivitySummary } from "./activityContract.js";
import { formatCount, formatShortDate } from "./activityFormat.js";
import { ActivityGithubNotice } from "./ActivityGithubNotice.js";

/**
 * Reviews given — work that leaves no commit behind and so is invisible on
 * every other card on this page. The split bar is the point: a reviewer who
 * approves everything and one who blocks half of what they read are doing two
 * different jobs, and one count cannot tell them apart.
 */

/** Recent rows before the list is cut. The card sits beside a taller ledger. */
const VISIBLE_ROWS = 5;

const STATE_LABEL: Record<ActivityReviewState, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented"
};

/** The order the split bar and its key both read in. */
const STATE_ORDER: readonly ActivityReviewState[] = ["approved", "changes_requested", "commented"];

/**
 * The bar's segments, left to right, in the bar's own 0–100 space. A verdict
 * that happened at all keeps a visible sliver rather than rounding away, and
 * the last segment is stretched to the end so the bar never shows a hairline
 * of track through rounding error.
 */
function splitBars(
  counts: Record<ActivityReviewState, number>,
  total: number
): Array<{ state: ActivityReviewState; x: number; width: number }> {
  const present = STATE_ORDER.filter((state) => counts[state] > 0);
  const bars: Array<{ state: ActivityReviewState; x: number; width: number }> = [];
  let x = 0;
  present.forEach((state, index) => {
    const last = index === present.length - 1;
    const width = last ? 100 - x : Math.max(1.2, Math.round((counts[state] / total) * 1000) / 10);
    bars.push({ state, x: Math.round(x * 10) / 10, width: Math.round(width * 10) / 10 });
    x += width;
  });
  return bars;
}

export function ActivityReviews({ summary }: { summary: ActivitySummary }): JSX.Element {
  const { totals, github, reviews } = summary;
  const counts: Record<ActivityReviewState, number> = {
    approved: totals.reviewApprovals,
    changes_requested: totals.reviewChangesRequested,
    commented: totals.reviewComments
  };
  const total = STATE_ORDER.reduce((sum, state) => sum + counts[state], 0);
  const repositories = new Set(reviews.map((review) => review.repository)).size;
  const pullRequests = new Set(reviews.map((review) => `${review.repository}#${review.number}`)).size;

  return (
    <section className="activity-card activity-reviews" aria-label="Reviews given">
      <div className="activity-card-head">
        <h2 className="activity-card-title">Reviews given</h2>
      </div>

      {!github.available ? (
        <ActivityGithubNotice github={github} />
      ) : total === 0 ? (
        <p className="activity-empty-note">No review submitted in this window.</p>
      ) : (
        <>
          <p className="activity-reviews-count">
            <span className="activity-reviews-figure">{formatCount(totals.reviewsGiven)}</span>
            <span className="activity-reviews-label">
              {totals.reviewsGiven === 1 ? "review" : "reviews"} on{" "}
              {formatCount(pullRequests)} pull{" "}
              {pullRequests === 1 ? "request" : "requests"}
            </span>
          </p>
          {/* A length is data, so it is an SVG attribute rather than an inline
              width — the same rule the Usage page's share meters follow. The
              corner is CSS: the box is rounded and clips its own bars. */}
          <svg
            className="activity-split"
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            role="img"
            aria-label={STATE_ORDER.filter((state) => counts[state] > 0)
              .map((state) => `${formatCount(counts[state])} ${STATE_LABEL[state]}`)
              .join(", ")}
          >
            {splitBars(counts, total).map((bar) => (
              <rect
                className="activity-split-part"
                key={bar.state}
                data-state={bar.state}
                x={bar.x}
                y="0"
                width={bar.width}
                height="8"
              />
            ))}
          </svg>
          <ul className="activity-split-key">
            {STATE_ORDER.map((state) => (
              <li key={state} data-state={state}>
                <span className="activity-split-swatch" aria-hidden="true" />
                <strong>{formatCount(counts[state])}</strong> {STATE_LABEL[state]}
              </li>
            ))}
          </ul>
          <dl className="activity-kv">
            <dt>Repositories reviewed</dt>
            <dd>{formatCount(repositories)}</dd>
            <dt>Approval rate</dt>
            <dd>{total > 0 ? `${Math.round((counts.approved / total) * 100)}%` : "—"}</dd>
          </dl>
          {reviews.length > 0 ? (
            <ul className="activity-recent" aria-label="Recently reviewed">
              {reviews.slice(0, VISIBLE_ROWS).map((review) => (
                <li key={`${review.repository}#${review.number}`}>
                  <span
                    className="activity-verdict"
                    data-state={review.state}
                    title={STATE_LABEL[review.state]}
                  />
                  <span className="activity-recent-what">
                    <span className="activity-recent-title">{review.title}</span>
                    <span className="activity-recent-repo">
                      {review.repository.split("/").pop()} #{review.number}
                    </span>
                  </span>
                  <span className="activity-recent-when">
                    {formatShortDate(review.submittedAt, summary.timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
