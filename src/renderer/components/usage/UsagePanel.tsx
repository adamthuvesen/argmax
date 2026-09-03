import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { UsageSummary, UsageWindow } from "../../../shared/types.js";
import { SegmentedControl } from "../settings/settingsPrimitives.js";
import { SkeletonPane } from "../SkeletonPane.js";
import { UsageAreaChart } from "./UsageAreaChart.js";
import { UsageBreakdown } from "./UsageBreakdown.js";
import { UsageHero } from "./UsageHero.js";
import { UsageProviderRows } from "./UsageProviderRows.js";
import { UsageTotals } from "./UsageTotals.js";
import { formatCount, formatRangeLabel, formatScanStamp } from "./usageFormat.js";
import { chartedProviders, type UsageMetric } from "./usagePresentation.js";

/** Warm refresh while the page is open. */
const REFRESH_MS = 60_000;
/** The first scan is still walking the transcripts, so the numbers move. */
const SCANNING_REFRESH_MS = 2_000;

const WINDOW_OPTIONS = [
  { value: "24h", label: "Past 24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
];

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" }
];

/** The zone day buckets are cut on. Asked for once; the backend echoes it back. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function fetchSummary(window: UsageWindow, timeZone: string): Promise<UsageSummary> {
  const api = globalThis.window?.argmax;
  if (api) return api.usage.summary({ window, timeZone });
  // No bridge: browser preview boots the whole app on demo data, and the
  // fixture is dynamic-imported so it never reaches the packaged bundle.
  const { demoUsageSummary } = await import("../../demoUsage.js");
  return demoUsageSummary({ window, timeZone });
}

export function UsagePanel(): JSX.Element {
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeZoneRef = useRef(hostTimeZone());
  // Only the newest request may write state: a slow 30-day scan must not
  // land on top of the 24h window the user switched to while it ran.
  const requestRef = useRef(0);

  const load = useCallback(
    async (target: UsageWindow): Promise<void> => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      try {
        const next = await fetchSummary(target, timeZoneRef.current);
        if (requestRef.current !== request) return;
        setSummary(next);
        setError(null);
      } catch (cause) {
        if (requestRef.current !== request) return;
        setError(cause instanceof Error ? cause.message : "Could not read usage.");
      }
    },
    []
  );

  useEffect(() => {
    setSummary(null);
    void load(usageWindow);
  }, [load, usageWindow]);

  const scanning = summary?.scan.phase === "scanning";
  useEffect(() => {
    const period = scanning ? SCANNING_REFRESH_MS : REFRESH_MS;
    const timer = globalThis.setInterval(() => void load(usageWindow), period);
    return () => globalThis.clearInterval(timer);
  }, [load, scanning, usageWindow]);

  const rangeLabel = summary
    ? formatRangeLabel(summary.rangeStart, summary.rangeEnd, summary.resolution, summary.timeZone)
    : "";
  const chartTitle = summary?.resolution === "hour" ? "Hourly" : "Daily";
  const chartHeading = `${chartTitle} ${metric === "cost" ? "cost" : "tokens"}`;

  return (
    <div className="settings-page usage-page">
      <div className="settings-topbar" data-window-drag />
      <div className="usage-main">
        <header className="usage-topbar">
          <div className="usage-titles">
            <h1 className="settings-page-title">Usage</h1>
            {rangeLabel ? <p className="usage-range">{rangeLabel}</p> : null}
          </div>
          <div className="usage-controls">
            <SegmentedControl
              ariaLabel="Show"
              name="usage-metric"
              value={metric}
              onChange={(next) => setMetric(next as UsageMetric)}
              options={METRIC_OPTIONS}
            />
            <SegmentedControl
              ariaLabel="Time range"
              name="usage-window"
              value={usageWindow}
              onChange={(next) => setUsageWindow(next as UsageWindow)}
              options={WINDOW_OPTIONS}
            />
          </div>
        </header>

        {error ? (
          <div className="usage-notice" data-tone="error" role="alert">
            <span>{error}</span>
            <button type="button" className="sched-button" onClick={() => void load(usageWindow)}>
              Try again
            </button>
          </div>
        ) : null}

        {summary ? <UsageBody summary={summary} metric={metric} chartHeading={chartHeading} /> : null}
        {!summary && !error ? <SkeletonPane /> : null}
      </div>
    </div>
  );
}

function UsageBody({
  summary,
  metric,
  chartHeading
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  chartHeading: string;
}): JSX.Element {
  const providers = chartedProviders(summary, metric);
  const nothingRecorded = summary.providers.every((row) => !row.available || row.sessions === 0);
  const lastScan = formatScanStamp(summary.scan.lastCompletedAt, summary.timeZone);

  if (summary.scan.phase === "scanning" && nothingRecorded) {
    return (
      <div className="usage-notice" data-tone="scanning" role="status">
        <span>
          Reading the provider transcripts — {formatCount(summary.scan.filesDone)} of{" "}
          {formatCount(summary.scan.filesTotal)} files. Numbers appear as they land.
        </span>
      </div>
    );
  }

  if (nothingRecorded) {
    return (
      <div className="usage-blank">
        <p className="usage-blank-headline">No usage in this window.</p>
        <p className="usage-blank-body">
          Argmax reads every transcript the provider CLIs left on disk, not only the sessions it
          started. Run an agent, or widen the range.
        </p>
      </div>
    );
  }

  return (
    <>
      {summary.scan.phase === "scanning" ? (
        <div className="usage-notice" data-tone="scanning" role="status">
          <span>
            Still scanning — {formatCount(summary.scan.filesDone)} of{" "}
            {formatCount(summary.scan.filesTotal)} files. These numbers are partial.
          </span>
        </div>
      ) : null}

      <div className="usage-grid">
        <section className="usage-summary-column" aria-label="Totals by provider">
          <UsageHero summary={summary} metric={metric} />
          <UsageProviderRows summary={summary} metric={metric} />
        </section>
        <section className="usage-chart-card" aria-label={chartHeading}>
          <div className="usage-section-head">
            <h2 className="usage-section-title">{chartHeading}</h2>
            {lastScan ? <span className="usage-scan-stamp">Scanned {lastScan}</span> : null}
          </div>
          <UsageAreaChart
            points={summary.series}
            providers={providers}
            metric={metric}
            resolution={summary.resolution}
            timeZone={summary.timeZone}
            title={chartHeading}
          />
        </section>
      </div>

      <section className="usage-section" aria-label="Totals">
        <div className="usage-section-head">
          <h2 className="usage-section-title">Totals</h2>
        </div>
        <UsageTotals summary={summary} />
      </section>

      <UsageBreakdown summary={summary} metric={metric} />
    </>
  );
}
