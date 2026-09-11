import type { JSX } from "react";

const STAT_KEYS = ["prs", "reviews", "days", "repos"] as const;
const ROW_KEYS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"] as const;
const HALF_KEYS = ["ledger", "reviews"] as const;

/**
 * The Activity page's own placeholder. The generic pane skeleton draws rows,
 * and this page is a dashboard: a numeral beside a year of cells, a full-width
 * chart, a repository list, then two cards side by side. The page waits for
 * its read before it paints anything, so this is on screen long enough that a
 * shape which is not the page's own would be a small lie (docs/styling.md).
 */
export function ActivitySkeleton({ note }: { note?: string }): JSX.Element {
  return (
    <div
      className="activity-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading activity"
    >
      <div className="activity-skeleton-hero">
        <div className="activity-skeleton-left">
          <span className="loading-block activity-skeleton-figure" />
          {STAT_KEYS.map((key) => (
            <span className="loading-block activity-skeleton-stat" key={key} />
          ))}
        </div>
        <span className="loading-block activity-skeleton-heat" />
      </div>
      <span className="loading-block activity-skeleton-chart" />
      <div className="activity-skeleton-rows">
        {ROW_KEYS.map((key) => (
          <span className="loading-block activity-skeleton-row" key={key} />
        ))}
      </div>
      <div className="activity-skeleton-split">
        {HALF_KEYS.map((key) => (
          <span className="loading-block activity-skeleton-half" key={key} />
        ))}
      </div>
      {/* The first walk of a dozen clones is slow enough that silence reads as
          a hang. Only the scanning path passes a note. */}
      {note ? <p className="activity-skeleton-note">{note}</p> : null}
    </div>
  );
}
