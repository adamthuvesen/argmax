import type { JSX } from "react";
import type { ActivityRepository, ActivitySummary } from "./activityContract.js";
import {
  formatAdded,
  formatCount,
  formatPercent,
  formatRemoved,
  formatSince
} from "./activityFormat.js";
import {
  barWidth,
  metricValue,
  repositorySlots,
  type ActivityMetric
} from "./activityPresentation.js";

/**
 * Every repository the ledger knows, ranked by the active metric. This is the
 * page's repository filter as well as its ranking: pressing a row narrows the
 * hero's numbers, the chart, the ledgers and the cadence to it, and pressing
 * it again widens back out — the same two-way relationship the Usage page's
 * provider tiles have with its provider picker.
 *
 * The rows themselves never narrow. Their point is the comparison, and a
 * one-row table is not one.
 */

/** How many rows are shown before the list is cut. */
const VISIBLE_ROWS = 8;
/** The sparkline's box, in its own coordinate space. */
const SPARK_WIDTH = 84;
const SPARK_HEIGHT = 20;
const SPARK_INSET = 3;
/**
 * The most points an 84px spark is drawn from. Thirty daily values in that
 * width is a hash, not a trend — the column exists to say "rising, falling, or
 * one burst", and pooling into a dozen steps is what makes that legible.
 */
const SPARK_POINTS = 12;

/** A repository's own curve over the window, as a polyline in the spark's box. */
function sparkPath(values: readonly number[]): { line: string; area: string; lastX: number; lastY: number } | null {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const span = SPARK_WIDTH - SPARK_INSET * 2;
  const height = SPARK_HEIGHT - SPARK_INSET * 2;
  const points = values.map((value, index) => {
    const x = SPARK_INSET + (span * index) / (values.length - 1);
    const y = SPARK_INSET + height - (max > 0 ? (value / max) * height : 0);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const last = points[points.length - 1];
  return {
    line,
    area: `${line} L${last[0]} ${SPARK_HEIGHT} L${points[0][0]} ${SPARK_HEIGHT} Z`,
    lastX: last[0],
    lastY: last[1]
  };
}

/** Pool a series down to at most `SPARK_POINTS` even-width steps. */
function pool(values: readonly number[]): number[] {
  if (values.length <= SPARK_POINTS) return [...values];
  const width = values.length / SPARK_POINTS;
  return Array.from({ length: SPARK_POINTS }, (_unused, step) => {
    const from = Math.floor(step * width);
    const to = Math.min(values.length, Math.floor((step + 1) * width));
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += values[index];
    return sum;
  });
}

/** Per-repository values per bucket, in the series' own bucket order. */
function seriesByRepository(
  summary: ActivitySummary,
  metric: ActivityMetric
): Map<string, number[]> {
  const byRepository = new Map<string, number[]>();
  summary.series.forEach((point, index) => {
    for (const slice of point.byRepository) {
      const values =
        byRepository.get(slice.projectId) ?? new Array<number>(summary.series.length).fill(0);
      values[index] += metricValue(slice, metric);
      byRepository.set(slice.projectId, values);
    }
  });
  return byRepository;
}

export function ActivityRepositories({
  summary,
  metric,
  selected,
  onSelect
}: {
  summary: ActivitySummary;
  metric: ActivityMetric;
  selected: string | null;
  onSelect: (projectId: string | null) => void;
}): JSX.Element {
  const slots = repositorySlots(summary.repositories);
  const withCommits = summary.repositories.filter((repo) => repo.commits > 0);
  const ranked = [...withCommits].sort(
    (left, right) => metricValue(right, metric) - metricValue(left, metric)
  );
  const rows = ranked.slice(0, VISIBLE_ROWS);
  const leader = rows.length > 0 ? metricValue(rows[0], metric) : 0;
  // The trend column follows the *window's* series, which the repository
  // filter narrows — so while the page is narrowed there is a curve for one
  // row and blank cells for the rest. The column is dropped instead: an empty
  // cell reads as "did nothing", which would be a lie.
  const spark = selected === null ? seriesByRepository(summary, metric) : null;
  // Every window ends at the present, so the window's own end is what "2h ago"
  // is measured from — and it keeps the fixture's clock out of the wall's.
  const now = new Date(summary.rangeEnd);

  if (rows.length === 0) {
    return (
      <section className="activity-card" aria-label="Repositories">
        <div className="activity-card-head">
          <h2 className="activity-card-title">Repositories</h2>
        </div>
        <p className="activity-empty-note">No repository recorded a commit in this window.</p>
      </section>
    );
  }

  return (
    <section className="activity-card" aria-label="Repositories">
      <div className="activity-card-head">
        <h2 className="activity-card-title">Repositories</h2>
        <p className="activity-card-note">
          <strong>{formatCount(withCommits.length)}</strong> with commits
          {withCommits.length > rows.length ? ` · top ${formatCount(rows.length)} shown` : null}
        </p>
      </div>
      <ul
        className="activity-repo-list"
        aria-label="Commits by repository"
        data-narrowed={selected ? "true" : "false"}
        data-trend={spark ? "true" : "false"}
      >
        <li className="activity-repo-row activity-repo-head" aria-hidden="true">
          <span>Repository</span>
          <span>{metric === "commits" ? "Commits" : "Lines"}</span>
          {spark ? <span>Trend</span> : null}
          <span className="activity-num">Total</span>
          <span className="activity-num">Added / removed</span>
          <span className="activity-num">Last commit</span>
        </li>
        {rows.map((repo) => (
          <RepositoryRow
            key={repo.projectId}
            repo={repo}
            metric={metric}
            slot={slots.get(repo.projectId) ?? "tail"}
            leader={leader}
            pressed={selected === repo.projectId}
            spark={spark?.get(repo.projectId) ?? null}
            timeZone={summary.timeZone}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

function RepositoryRow({
  repo,
  metric,
  slot,
  leader,
  pressed,
  spark,
  timeZone,
  now,
  onSelect
}: {
  repo: ActivityRepository;
  metric: ActivityMetric;
  slot: string;
  /** The top row's figure: bars are drawn against the leader, not the total. */
  leader: number;
  pressed: boolean;
  spark: readonly number[] | null;
  timeZone: string;
  /** What "2h ago" is measured from. */
  now: Date;
  onSelect: (projectId: string | null) => void;
}): JSX.Element {
  const value = metricValue(repo, metric);
  const path = spark ? sparkPath(pool(spark)) : null;

  return (
    <li
      className="activity-repo-row activity-series"
      data-slot={slot}
      data-selected={pressed ? "true" : "false"}
    >
      <button
        type="button"
        className="activity-repo-toggle"
        aria-pressed={pressed}
        title={pressed ? "Show every repository" : `Show only ${repo.name}`}
        onClick={() => onSelect(pressed ? null : repo.projectId)}
      >
        <span className="activity-repo-name">
          <span className="activity-series-dot" aria-hidden="true" />
          <span className="activity-repo-label">{repo.name}</span>
        </span>
        {/* The bar's length is data, so it is an SVG attribute rather than an
            inline width; everything else about it is CSS. Decorative — the
            figure is in the Count column. */}
        <svg
          className="activity-repo-bar"
          viewBox="0 0 100 6"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <rect className="activity-repo-bar-track" x="0" y="0" width="100" height="6" rx="3" />
          <rect
            className="activity-repo-bar-fill"
            x="0"
            y="0"
            width={barWidth(leader > 0 ? value / leader : 0)}
            height="6"
            rx="3"
          />
        </svg>
        {path ? (
          <svg
            className="activity-spark"
            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
            role="img"
            aria-label={`${repo.name} over the window`}
            focusable="false"
          >
            <path className="activity-spark-area" d={path.area} />
            <path className="activity-spark-line" d={path.line} />
            <circle className="activity-spark-dot" cx={path.lastX} cy={path.lastY} r="1.8" />
          </svg>
        ) : null}
        <span className="activity-repo-count activity-num">{formatCount(value)}</span>
        <span className="activity-repo-lines activity-num">
          <span className="activity-plus">{formatAdded(repo.linesAdded)}</span>{" "}
          <span className="activity-minus">{formatRemoved(repo.linesRemoved)}</span>
        </span>
        <span className="activity-repo-last activity-num">
          {formatSince(repo.lastCommitAt, timeZone, now)}
        </span>
        {/* The share rides in the row's accessible name rather than in a
            column of its own: the bar already says it, and a sixth column
            pushed the repository name to an ellipsis. */}
        <span className="activity-visually-hidden">{formatPercent(repo.share)} of commits</span>
      </button>
    </li>
  );
}
