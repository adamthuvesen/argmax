import type { UsageSeriesPoint, UsageSummary } from "../../../shared/types.js";
import type { UsageMetric } from "./usagePresentation.js";

/**
 * What the fold can say about a window beyond its total. Everything here is
 * derived from the summary the page already holds, so none of it costs a
 * second query.
 *
 * The window's last bucket is the one still filling: today is not over, and
 * in a 24h window the current hour may be a minute old. Counting it drags an
 * average toward zero every morning and lets a half-finished day claim the
 * peak, so these figures only ever look at *completed* buckets — and say
 * nothing at all until there are two of them.
 */

/** The fewest completed buckets that make an average or a peak worth stating. */
const MIN_BUCKETS = 2;

export interface UsageAverage {
  /** The mean over completed buckets, in the metric's own units. */
  value: number;
  /** How a sentence names one bucket: `a day` or `an hour`. */
  unitLabel: string;
}

export interface UsagePeak {
  /** RFC 3339 UTC start of the busiest completed bucket. */
  bucketStart: string;
  /** How a sentence names it: `Aug 30`, or `Aug 30, 14:00` in a 24h window. */
  label: string;
  /** The bucket's total, in the metric's own units. */
  value: number;
}

/** How this window compares with the one before it. */
export interface UsageDelta {
  direction: "up" | "down" | "flat";
  /** The size of the change as a fraction: `0.184` is 18.4%. */
  ratio: number;
  /** What it is being compared with, e.g. `the previous 30 days`. */
  previousLabel: string;
}

/** Every bucket but the one still filling. */
function completedBuckets(summary: UsageSummary): UsageSeriesPoint[] {
  return summary.series.slice(0, -1);
}

/** One bucket's total across the providers the series carries. */
function bucketTotal(point: UsageSeriesPoint, metric: UsageMetric): number {
  return point.values.reduce(
    (sum, value) => sum + (metric === "cost" ? value.costUsd : value.tokens),
    0
  );
}

/**
 * `Aug 30`, or `Aug 30, 14:00` when the buckets are hours. `Intl` throws on a
 * zone it does not recognise and the zone reaches us from the backend rather
 * than from a literal, so a bad value falls back to the host zone instead of
 * taking the page down with it.
 */
function bucketStamp(bucketStart: string, summary: UsageSummary): string {
  const at = new Date(bucketStart);
  if (Number.isNaN(at.getTime())) return "";
  const options: Intl.DateTimeFormatOptions =
    summary.resolution === "hour"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "short", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: summary.timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(at);
  }
}

/**
 * The window's mean per completed bucket — a day for 7d and 30d, an hour for
 * 24h. `null` when the window has fewer than two completed buckets, or when
 * nothing was spent in them: `$0.00 a day` is not an insight.
 */
export function perBucketAverage(summary: UsageSummary, metric: UsageMetric): UsageAverage | null {
  const buckets = completedBuckets(summary);
  if (buckets.length < MIN_BUCKETS) return null;
  const total = buckets.reduce((sum, point) => sum + bucketTotal(point, metric), 0);
  const value = total / buckets.length;
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unitLabel: summary.resolution === "hour" ? "an hour" : "a day" };
}

/**
 * The busiest completed bucket and what it cost, so the fold can say
 * "busiest Aug 30, $118.40". Ties keep the earlier bucket. `null` when the
 * window is too young to have a busiest anything, or when nothing moved.
 */
export function peakBucket(summary: UsageSummary, metric: UsageMetric): UsagePeak | null {
  const buckets = completedBuckets(summary);
  if (buckets.length < MIN_BUCKETS) return null;
  let peak: UsagePeak | null = null;
  for (const point of buckets) {
    const value = bucketTotal(point, metric);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (peak && peak.value >= value) continue;
    peak = {
      bucketStart: point.bucketStart,
      label: bucketStamp(point.bucketStart, summary),
      value
    };
  }
  return peak;
}
