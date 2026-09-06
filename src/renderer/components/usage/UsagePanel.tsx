import { CalendarDays } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { ProviderId, UsageRemaining, UsageSummary, UsageWindow } from "../../../shared/types.js";
import { SegmentedControl, SettingsListPicker } from "../settings/settingsPrimitives.js";
import { SkeletonPane } from "../SkeletonPane.js";
import { UsageAreaChart } from "./UsageAreaChart.js";
import { UsageBreakdown } from "./UsageBreakdown.js";
import { UsageHero } from "./UsageHero.js";
import { UsageProviderRows } from "./UsageProviderRows.js";
import { UsageRemainingCard } from "./UsageRemaining.js";
import { UsageTokenFlow } from "./UsageTokenFlow.js";
import { formatCount, formatRangeLabel, formatScanStamp } from "./usageFormat.js";
import type { UsageDelta } from "./usageInsights.js";
import {
  chartedProviders,
  processedTokens,
  providerLabel,
  USAGE_PROVIDER_ORDER,
  type UsageMetric
} from "./usagePresentation.js";

/** Warm refresh while the page is open. */
const REFRESH_MS = 60_000;
/** The first scan is still walking the transcripts, so the numbers move. */
const SCANNING_REFRESH_MS = 2_000;

const WINDOW_OPTIONS: ReadonlyArray<{ value: UsageWindow; label: string }> = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" }
];

/** The picker's value for "every provider"; the backend takes `null`. */
const ALL_PROVIDERS = "all";
type ProviderChoice = ProviderId | typeof ALL_PROVIDERS;

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" }
];

/** What the delta chip compares this window against, said in words. */
const PREVIOUS_LABEL: Record<UsageWindow, string> = {
  "24h": "the previous 24 hours",
  "7d": "the previous 7 days",
  "30d": "the previous 30 days"
};

/**
 * The window against the one before it. The backend returns `previous` as
 * `null` when the ledger does not cover that earlier window, and a period that
 * recorded nothing is not a baseline — a first week would otherwise read as an
 * infinite rise.
 */
function windowDelta(summary: UsageSummary, metric: UsageMetric): UsageDelta | null {
  const previous = summary.previous;
  if (!previous) return null;
  const before = metric === "cost" ? previous.costUsd : processedTokens(previous.tokens);
  const now = metric === "cost" ? summary.costUsd : processedTokens(summary.tokens);
  if (!(before > 0) || !Number.isFinite(now)) return null;
  const ratio = (now - before) / before;
  // Under a percent either way is noise, not a trend.
  const direction = Math.abs(ratio) < 0.01 ? "flat" : ratio > 0 ? "up" : "down";
  return { direction, ratio, previousLabel: PREVIOUS_LABEL[summary.window] };
}

/** The zone day buckets are cut on. Asked for once; the backend echoes it back. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function fetchSummary(
  window: UsageWindow,
  provider: ProviderId | null,
  timeZone: string
): Promise<UsageSummary> {
  const api = globalThis.window?.argmax;
  if (api) return api.usage.summary({ window, provider, timeZone });
  // No bridge: browser preview boots the whole app on demo data, and the
  // fixture is dynamic-imported so it never reaches the packaged bundle.
  const { demoUsageSummary } = await import("../../demoUsage.js");
  return demoUsageSummary({ window, provider, timeZone });
}

async function fetchRemaining(): Promise<UsageRemaining> {
  const api = globalThis.window?.argmax;
  if (api?.usage.remaining) return api.usage.remaining();
  const { demoUsageRemaining } = await import("../../demoUsage.js");
  return demoUsageRemaining();
}

export function UsagePanel(): JSX.Element {
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  /** The provider the page is narrowed to; null is every provider. */
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<UsageRemaining | null>(null);
  const [remainingError, setRemainingError] = useState<string | null>(null);
  const timeZoneRef = useRef(hostTimeZone());
  // Only the newest request may write state: a slow 30-day scan must not
  // land on top of the 24h window the user switched to while it ran.
  const requestRef = useRef(0);
  const remainingRequestRef = useRef(0);

  const load = useCallback(
    async (target: UsageWindow, scope: ProviderId | null): Promise<void> => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      try {
        const next = await fetchSummary(target, scope, timeZoneRef.current);
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

  const loadRemaining = useCallback(async (): Promise<void> => {
    const request = remainingRequestRef.current + 1;
    remainingRequestRef.current = request;
    try {
      const next = await fetchRemaining();
      if (remainingRequestRef.current !== request) return;
      setRemaining(next);
      setRemainingError(null);
    } catch (cause) {
      if (remainingRequestRef.current !== request) return;
      setRemainingError(cause instanceof Error ? cause.message : "Could not read remaining usage.");
    }
  }, []);

  // A new window clears the page to a skeleton: its numbers mean something
  // else. A new provider keeps the page up and swaps the figures when they
  // land — a warm sweep is sub-second, and a skeleton flash on every row
  // press would make the filter feel like navigation.
  useEffect(() => {
    setSummary(null);
  }, [usageWindow]);

  useEffect(() => {
    void load(usageWindow, provider);
  }, [load, provider, usageWindow]);

  useEffect(() => {
    void loadRemaining();
  }, [loadRemaining]);

  const scanning = summary?.scan.phase === "scanning";
  useEffect(() => {
    const period = scanning ? SCANNING_REFRESH_MS : REFRESH_MS;
    const timer = globalThis.setInterval(() => void load(usageWindow, provider), period);
    return () => globalThis.clearInterval(timer);
  }, [load, provider, scanning, usageWindow]);

  const rangeLabel = summary
    ? formatRangeLabel(summary.rangeStart, summary.rangeEnd, summary.resolution, summary.timeZone)
    : "";
  const chartTitle = summary?.resolution === "hour" ? "Hourly" : "Daily";
  const chartHeading = `${chartTitle} ${metric === "cost" ? "cost" : "tokens"}`;
  const scanStamp = summary ? formatScanStamp(summary.scan.lastCompletedAt, summary.timeZone) : null;

  return (
    <div className="settings-page usage-page">
      <div className="settings-topbar" data-window-drag />
      <div className="usage-main">
        <header className="usage-topbar">
          <div className="usage-titles">
            <h1 className="settings-page-title">Usage</h1>
            {rangeLabel ? (
              <p className="usage-range">
                <span>{rangeLabel}</span>
                {/* The scan stamp qualifies every figure on the page, so it
                    sits with the range rather than under whichever card it
                    used to live in. */}
                {scanStamp ? (
                  <>
                    <span className="usage-dot-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="usage-scan-stamp">Scanned {scanStamp}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="usage-controls">
            <UsageProviderPicker
              summary={summary}
              value={provider}
              onChange={setProvider}
            />
            <SettingsListPicker<UsageWindow>
              ariaLabel="Time range"
              icon={<CalendarDays size={13} aria-hidden="true" />}
              value={usageWindow}
              onChange={setUsageWindow}
              options={WINDOW_OPTIONS}
            />
            <SegmentedControl
              ariaLabel="Show"
              name="usage-metric"
              value={metric}
              onChange={(next) => setMetric(next as UsageMetric)}
              options={METRIC_OPTIONS}
            />
          </div>
        </header>

        {error ? (
          <div className="usage-notice" data-tone="error" role="alert">
            <span>{error}</span>
            <button type="button" className="sched-button" onClick={() => void load(usageWindow, provider)}>
              Try again
            </button>
          </div>
        ) : null}

        {summary ? (
          <UsageBody
            summary={summary}
            metric={metric}
            chartHeading={chartHeading}
            provider={provider}
            onSelectProvider={setProvider}
          />
        ) : null}
        {!summary && !error ? <SkeletonPane /> : null}

        <UsageRemainingCard
          remaining={remaining}
          error={remainingError}
          timeZone={timeZoneRef.current}
          onRefresh={() => void loadRemaining()}
        />
      </div>
    </div>
  );
}

/**
 * The page's provider filter, as a picker beside the range. The ranked rows
 * in the fold narrow the page too; both drive the same state, so a row press
 * shows up here and a pick here presses the row. A provider with no local
 * usage source is listed but cannot be chosen: there is nothing to narrow to.
 */
function UsageProviderPicker({
  summary,
  value,
  onChange
}: {
  summary: UsageSummary | null;
  value: ProviderId | null;
  onChange: (provider: ProviderId | null) => void;
}): JSX.Element {
  const unavailable = new Set(
    (summary?.providers ?? []).filter((row) => !row.available).map((row) => row.provider)
  );
  const options: Array<{
    value: ProviderChoice;
    label: string;
    disabled?: boolean;
    title?: string;
    icon?: JSX.Element;
  }> = [
    { value: ALL_PROVIDERS, label: "All providers" },
    ...USAGE_PROVIDER_ORDER.map((id) => ({
      value: id,
      label: providerLabel(id),
      disabled: unavailable.has(id),
      title: unavailable.has(id) ? "No local usage data" : undefined,
      icon: <span className="usage-series usage-series-dot" data-provider={id} aria-hidden="true" />
    }))
  ];
  return (
    <SettingsListPicker<ProviderChoice>
      ariaLabel="Provider"
      value={value ?? ALL_PROVIDERS}
      onChange={(next) => onChange(next === ALL_PROVIDERS ? null : next)}
      options={options}
    />
  );
}

function UsageBody({
  summary,
  metric,
  chartHeading,
  provider,
  onSelectProvider
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  chartHeading: string;
  provider: ProviderId | null;
  onSelectProvider: (provider: ProviderId | null) => void;
}): JSX.Element {
  const providers = chartedProviders(summary, metric);
  const nothingRecorded = summary.providers.every((row) => !row.available || row.sessions === 0);

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

      {/* The total and who it is made of, side by side on one band; the curve
          gets the page's whole width under it. A 30-day chart squeezed into
          half a window is a smear — the totals read fine in a column, the
          chart does not. */}
      <section className="usage-summary" aria-label="Totals by provider">
        <UsageHero
          summary={summary}
          metric={metric}
          delta={windowDelta(summary, metric)}
          onShowAll={() => onSelectProvider(null)}
        />
        <UsageProviderRows
          summary={summary}
          metric={metric}
          selected={provider}
          onSelect={onSelectProvider}
        />
      </section>
      <section className="usage-chart-card" aria-label={chartHeading}>
        <div className="usage-section-head">
          <h2 className="usage-section-title">{chartHeading}</h2>
          {/* The chart's own key. The tiles above it carry the same colours,
              but a reader scanning the curves should not have to look away
              from them to learn which is which. */}
          <ul className="usage-chart-legend" aria-hidden="true">
            {providers.map((id) => (
              <li className="usage-chart-legend-item usage-series" key={id} data-provider={id}>
                <span className="usage-series-dot" />
                {providerLabel(id)}
              </li>
            ))}
          </ul>
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

      <UsageTokenFlow summary={summary} />

      <UsageBreakdown summary={summary} metric={metric} />
    </>
  );
}
