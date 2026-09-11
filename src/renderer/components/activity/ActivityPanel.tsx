import { CalendarDays, FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  getActivityUiState,
  getCachedActivitySummary,
  patchActivityUiState,
  setCachedActivitySummary
} from "../../lib/ledgerPageState.js";
import { SegmentedControl, SettingsListPicker } from "../settings/settingsPrimitives.js";
import type { ActivitySummary, ActivityWindow } from "./activityContract.js";
import { formatCount, formatRangeLabel, formatScanStamp } from "./activityFormat.js";
import {
  ACTIVITY_METRIC_OPTIONS,
  activityWindowOptions,
  chartSeries,
  metricValue,
  repositorySlots,
  windowDelta,
  type ActivityMetric
} from "./activityPresentation.js";
import { ActivityCadence } from "./ActivityCadence.js";
import { ActivityChart } from "./ActivityChart.js";
import { ActivityHero } from "./ActivityHero.js";
import { ActivityPullRequests } from "./ActivityPullRequests.js";
import { ActivityRepositories } from "./ActivityRepositories.js";
import { ActivityReviews } from "./ActivityReviews.js";
import { ActivitySkeleton } from "./ActivitySkeleton.js";

/**
 * Activity — the Usage page's sibling under the same rail. Usage answers what
 * the agents cost; this answers what came out the other end: commits, lines,
 * streaks, pull requests, reviews.
 *
 * The page is one column of cards. The hero opens it (the window's number
 * beside the year it sits inside), then the chart at full width, then the
 * repositories, then the two GitHub ledgers side by side, then cadence. It
 * follows the Usage page's chrome exactly — rail, empty drag strip, title in
 * the column, pickers top-right — because the two are one place with two
 * questions, not two designs.
 */

/** Warm refresh while the page is open. */
const REFRESH_MS = 60_000;
/** The first walk of the clones is still going, so the numbers move. */
const SCANNING_REFRESH_MS = 2_000;

/** The picker's value for "every repository"; the backend takes `null`. */
const ALL_REPOSITORIES = "all";

/** The zone day buckets are cut on. Asked for once; the backend echoes it back. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function fetchSummary(
  activityWindow: ActivityWindow,
  projectId: string | null,
  timeZone: string
): Promise<ActivitySummary> {
  const api = globalThis.window?.argmax;
  if (api) return api.activity.summary({ window: activityWindow, projectId, timeZone });
  // No bridge: the browser preview boots the whole app on demo data, and the
  // fixture is dynamic-imported so it never reaches the packaged bundle.
  const { demoActivitySummary } = await import("../../demoActivity.js");
  return demoActivitySummary({ window: activityWindow, projectId, timeZone });
}

export function ActivityPanel({ visible = true }: { visible?: boolean } = {}): JSX.Element {
  const cachedUi = getActivityUiState();
  const timeZoneRef = useRef(hostTimeZone());
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>(cachedUi.activityWindow);
  const [metric, setMetric] = useState<ActivityMetric>(cachedUi.metric);
  /** The repository the page is narrowed to; null is every repository. */
  const [projectId, setProjectId] = useState<string | null>(cachedUi.projectId);
  const [summary, setSummary] = useState<ActivitySummary | null>(() =>
    getCachedActivitySummary(cachedUi.activityWindow, cachedUi.projectId, timeZoneRef.current)
  );
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state: a slow 12-month walk must not
  // land on top of the 24h window the user switched to while it ran.
  const requestRef = useRef(0);

  const load = useCallback(
    async (target: ActivityWindow, scope: string | null): Promise<void> => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      try {
        const next = await fetchSummary(target, scope, timeZoneRef.current);
        if (requestRef.current !== request) return;
        setCachedActivitySummary(target, scope, timeZoneRef.current, next);
        setSummary(next);
        setError(null);
      } catch (cause) {
        if (requestRef.current !== request) return;
        setError(cause instanceof Error ? cause.message : "Could not read your activity.");
      }
    },
    []
  );

  useEffect(() => {
    patchActivityUiState({ activityWindow, metric, projectId });
  }, [activityWindow, metric, projectId]);

  // A new window clears to a skeleton only when nothing is cached for it.
  // Repository changes keep the page up and swap the figures when they land —
  // a warm read is sub-second, and a skeleton flash on every row press would
  // make the filter feel like navigation.
  useEffect(() => {
    setSummary(getCachedActivitySummary(activityWindow, projectId, timeZoneRef.current));
  }, [activityWindow]);

  useEffect(() => {
    if (!visible) return;
    void load(activityWindow, projectId);
  }, [activityWindow, load, projectId, visible]);

  const scanning = summary?.scan.phase === "scanning";
  useEffect(() => {
    if (!visible) return;
    const period = scanning ? SCANNING_REFRESH_MS : REFRESH_MS;
    const timer = globalThis.setInterval(
      () => void load(activityWindow, projectId),
      period
    );
    return () => globalThis.clearInterval(timer);
  }, [activityWindow, load, projectId, scanning, visible]);

  const windowOptions = useMemo(
    () => activityWindowOptions(new Date().getFullYear()),
    []
  );

  const rangeLabel = summary
    ? formatRangeLabel(summary.rangeStart, summary.rangeEnd, summary.resolution, summary.timeZone)
    : "";
  const scanStamp = summary ? formatScanStamp(summary.scan.lastCompletedAt, summary.timeZone) : null;
  const withCommits = summary?.repositories.filter((repo) => repo.commits > 0).length ?? 0;
  const author = summary?.authorEmails[0] ?? null;

  return (
    <div className="settings-page activity-page">
      <div className="settings-topbar" data-window-drag />
      <div className="activity-main">
        <header className="activity-topbar">
          <div className="activity-titles">
            <h1 className="settings-page-title">Activity</h1>
            {rangeLabel ? (
              <p className="activity-range">
                <span>{rangeLabel}</span>
                <span className="activity-dot-sep" aria-hidden="true">
                  ·
                </span>
                <span>
                  {formatCount(withCommits)}{" "}
                  {withCommits === 1 ? "repository" : "repositories"}
                </span>
                {/* Which identity the commits were matched on. Two machines
                    and a work email make this the difference between 184
                    commits and none. */}
                {author ? (
                  <>
                    <span className="activity-dot-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="activity-range-quiet">{author}</span>
                  </>
                ) : null}
                {scanStamp ? (
                  <>
                    <span className="activity-dot-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="activity-range-quiet">Scanned {scanStamp}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="activity-controls">
            <ActivityRepositoryPicker
              summary={summary}
              value={projectId}
              onChange={setProjectId}
            />
            <SettingsListPicker<ActivityWindow>
              ariaLabel="Time range"
              icon={<CalendarDays size={13} aria-hidden="true" />}
              value={activityWindow}
              onChange={setActivityWindow}
              options={windowOptions}
            />
            <SegmentedControl
              ariaLabel="Measure"
              name="activity-metric"
              value={metric}
              onChange={(next) => setMetric(next as ActivityMetric)}
              options={ACTIVITY_METRIC_OPTIONS}
            />
          </div>
        </header>

        {error ? (
          <div className="activity-notice" data-tone="error" role="alert">
            <p className="activity-notice-line">{error}</p>
            <button
              type="button"
              className="sched-button"
              onClick={() => void load(activityWindow, projectId)}
            >
              Try again
            </button>
          </div>
        ) : null}

        {summary ? (
          <ActivityBody
            summary={summary}
            metric={metric}
            projectId={projectId}
            onSelectRepository={setProjectId}
          />
        ) : null}
        {!summary && !error ? <ActivitySkeleton /> : null}
      </div>
    </div>
  );
}

/**
 * The page's repository filter, as a picker beside the range. The rows in the
 * repositories card narrow the page too; both drive the same state, so a row
 * press shows up here and a pick here presses the row. A repository with no
 * commits in the window is listed but cannot be chosen: there is nothing to
 * narrow to.
 */
function ActivityRepositoryPicker({
  summary,
  value,
  onChange
}: {
  summary: ActivitySummary | null;
  value: string | null;
  onChange: (projectId: string | null) => void;
}): JSX.Element {
  const slots = repositorySlots(summary?.repositories ?? []);
  const options = [
    { value: ALL_REPOSITORIES, label: "All repositories" },
    ...(summary?.repositories ?? []).map((repo) => ({
      value: repo.projectId,
      label: repo.name,
      disabled: repo.commits === 0,
      title: repo.commits === 0 ? "No commits in this window" : repo.path,
      icon: (
        <span
          className="activity-series activity-series-dot"
          data-slot={slots.get(repo.projectId) ?? "tail"}
          aria-hidden="true"
        />
      )
    }))
  ];
  return (
    <SettingsListPicker<string>
      ariaLabel="Repository"
      icon={<FolderGit2 size={13} aria-hidden="true" />}
      value={value ?? ALL_REPOSITORIES}
      onChange={(next) => onChange(next === ALL_REPOSITORIES ? null : next)}
      options={options}
    />
  );
}

function ActivityBody({
  summary,
  metric,
  projectId,
  onSelectRepository
}: {
  summary: ActivitySummary;
  metric: ActivityMetric;
  projectId: string | null;
  onSelectRepository: (projectId: string | null) => void;
}): JSX.Element {
  const series = chartSeries(summary, metric);
  const chartHeading = `${summary.resolution === "hour" ? "Hourly" : summary.resolution === "week" ? "Weekly" : "Daily"} ${metric === "commits" ? "commits" : "lines"}`;
  const nothingRecorded = summary.repositories.length === 0;

  if (nothingRecorded) {
    return (
      <div className="activity-blank">
        <p className="activity-blank-headline">No repositories to read yet.</p>
        <p className="activity-blank-body">
          Activity is walked out of the git clones behind your projects. Add a project, and every
          commit you have authored in it — on any branch — shows up here.
        </p>
      </div>
    );
  }

  if (summary.scan.phase === "scanning" && metricValue(summary.totals, metric) === 0) {
    return (
      <ActivitySkeleton
        note={`Walking your clones — ${formatCount(summary.scan.reposDone)} of ${formatCount(summary.scan.reposTotal)} repositories. Numbers appear as they land.`}
      />
    );
  }

  return (
    <>
      {summary.scan.phase === "scanning" ? (
        <div className="activity-notice" data-tone="scanning" role="status">
          <p className="activity-notice-line">
            Still walking your clones — {formatCount(summary.scan.reposDone)} of{" "}
            {formatCount(summary.scan.reposTotal)} repositories. These numbers are partial.
          </p>
        </div>
      ) : null}

      <ActivityHero summary={summary} metric={metric} delta={windowDelta(summary, metric)} />

      {/* Nothing shares a row with the chart: a 30-day curve in half a window
          is a smear, and the card states its own height rather than stretching
          to whatever sits beside it. */}
      <section className="activity-card activity-chart-card" aria-label={chartHeading}>
        <div className="activity-card-head">
          <h2 className="activity-card-title">{chartHeading}</h2>
          {/* The chart's own key. The repository rows below carry the same
              colours, but a reader scanning the bands should not have to look
              away from them to learn which is which. */}
          <ul className="activity-chart-legend" aria-hidden="true">
            {series.map((entry) => (
              <li
                className="activity-chart-legend-item activity-series"
                key={entry.key}
                data-slot={entry.slot}
              >
                <span className="activity-series-dot" />
                {entry.label}
              </li>
            ))}
          </ul>
        </div>
        <ActivityChart
          points={summary.series}
          series={series}
          resolution={summary.resolution}
          timeZone={summary.timeZone}
          title={chartHeading}
        />
      </section>

      <ActivityRepositories
        summary={summary}
        metric={metric}
        selected={projectId}
        onSelect={onSelectRepository}
      />

      {/* The two GitHub cards. They fail together and independently of the
          rest of the page: a signed-out `gh` costs these two panels, not the
          commits above them. */}
      <div className="activity-two-col">
        <ActivityPullRequests summary={summary} />
        <ActivityReviews summary={summary} />
      </div>

      <ActivityCadence cadence={summary.cadence} commits={summary.totals.commits} />
    </>
  );
}
