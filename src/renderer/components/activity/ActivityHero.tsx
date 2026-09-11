import { useId, type JSX } from "react";
import type { ActivitySummary } from "./activityContract.js";
import {
  formatAdded,
  formatCalendarDate,
  formatCount,
  formatDeltaRatio,
  formatDuration,
  formatHeroCount,
  formatRemoved
} from "./activityFormat.js";
import {
  metricValue,
  type ActivityDelta,
  type ActivityMetric
} from "./activityPresentation.js";
import { ActivityHeatmap } from "./ActivityHeatmap.js";

/**
 * The page's opening: the window's one number on the left, the year it sits
 * inside on the right. The numeral answers "how much"; the heatmap beside it
 * answers "and is that normal for me", which is the question a single figure
 * can never settle on its own.
 *
 * The heatmap is deliberately *not* narrowed by the repository filter — it is
 * the shape of the year, and a filter that redrew it would take away the
 * comparison the reader came for. Same rule as the Usage page's provider
 * tiles.
 */

const DELTA_GLYPH: Record<ActivityDelta["direction"], string> = {
  up: "↑",
  down: "↓",
  flat: "→"
};

/** The direction for a reader who cannot see the glyph. */
const DELTA_WORD: Record<ActivityDelta["direction"], string> = {
  up: "up",
  down: "down",
  flat: "level"
};

/**
 * Deliberately neutral ink. Committing less this month than last is not an
 * error state, and painting it in `--rose` would be the page moralising about
 * the user's own week. Only the line counts get colour, where +/- is the
 * measurement rather than a verdict.
 */
function ActivityDeltaChip({ delta }: { delta: ActivityDelta }): JSX.Element {
  return (
    <span className="activity-delta" data-direction={delta.direction}>
      <span className="activity-delta-glyph" aria-hidden="true">
        {DELTA_GLYPH[delta.direction]}
      </span>
      <span className="activity-visually-hidden">{DELTA_WORD[delta.direction]}</span>
      {formatDeltaRatio(delta.ratio)}
      <span className="activity-delta-vs">vs {delta.previousLabel}</span>
    </span>
  );
}

export function ActivityHero({
  summary,
  metric,
  delta
}: {
  summary: ActivitySummary;
  metric: ActivityMetric;
  delta: ActivityDelta | null;
}): JSX.Element {
  const eyebrowId = useId();
  const { totals, streaks } = summary;
  const figure = metricValue(totals, metric);

  return (
    <section className="activity-card activity-hero" aria-label="Summary">
      <div className="activity-hero-left">
        <div className="activity-hero-total">
          {/* The eyebrow is the figure's label, so it names it rather than
              being read as a stray line above it. */}
          <p className="activity-eyebrow" id={eyebrowId}>
            {metric === "commits" ? "Commits" : "Lines changed"}
          </p>
          {/* The exact count stays reachable on hover for the windows where
              the figure is shown rounded. */}
          <p
            className="activity-hero-figure"
            aria-labelledby={eyebrowId}
            title={formatCount(figure)}
          >
            {formatHeroCount(figure)}
          </p>
          <p className="activity-hero-figure-label">
            {metric === "commits"
              ? `across ${formatCount(totals.filesChanged)} file changes`
              : `${formatAdded(totals.linesAdded)} / ${formatRemoved(totals.linesRemoved)}`}
          </p>
        </div>
        {delta ? <ActivityDeltaChip delta={delta} /> : null}
        <dl className="activity-hero-stats">
          <div className="activity-hero-stat">
            <dt>PRs merged</dt>
            <dd>{formatCount(totals.prsMerged)}</dd>
          </div>
          <div className="activity-hero-stat">
            <dt>Reviews given</dt>
            <dd>{formatCount(totals.reviewsGiven)}</dd>
          </div>
          <div className="activity-hero-stat">
            <dt>Active days</dt>
            <dd>{formatCount(totals.activeDays)}</dd>
          </div>
          <div className="activity-hero-stat">
            {/* The range line already says how many repositories carried the
                window, so the fourth slot spends itself on the one figure
                nothing else on the page states in the open. */}
            <dt>Median cycle</dt>
            <dd>
              {summary.medianCycleSeconds !== null
                ? formatDuration(summary.medianCycleSeconds)
                : "—"}
            </dd>
          </div>
        </dl>
      </div>
      <div className="activity-hero-right">
        <p className="activity-eyebrow activity-hero-eyebrow">
          Contributions
          <span className="activity-hero-eyebrow-note">the last 365 days, every repository</span>
        </p>
        <ActivityHeatmap days={summary.heatmap} />
        {/* One line under the grid instead of a column of stat blocks beside
            it: the streaks are a caption on the picture above them, and a
            third column made the card the tallest thing on the page. */}
        <p className="activity-hero-streaks">
          <span className="activity-hero-streak">
            <strong>{formatCount(streaks.currentDays)}</strong>
            {streaks.currentDays === 1 ? " day streak" : " days running"}
          </span>
          <span className="activity-dot-sep" aria-hidden="true">
            ·
          </span>
          <span>longest {formatCount(streaks.longestDays)}</span>
          {streaks.busiestDay ? (
            <>
              <span className="activity-dot-sep" aria-hidden="true">
                ·
              </span>
              <span>
                busiest {formatCalendarDate(streaks.busiestDay.date)},{" "}
                {formatCount(streaks.busiestDay.commits)} commits
              </span>
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}
