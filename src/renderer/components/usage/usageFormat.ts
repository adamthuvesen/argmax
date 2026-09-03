import { formatTokens } from "../../formatTokens.js";
import type { UsageResolution } from "../../../shared/types.js";

/**
 * Number shapes for the Usage page. Every figure on the page is set in
 * tabular numerals, so widths here are chosen to line up in a column rather
 * than to be as short as possible.
 */

/** `$25,118.49`. Sub-cent totals keep their cents rather than rounding to $0. */
export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** `$25.1k` — the axis tick shape, where two decimals would crowd the gutter. */
export function formatUsdCompact(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  const sign = safe < 0 ? "-" : "";
  if (abs >= 999_500) return `${sign}$${trimScaled(abs / 1_000_000)}M`;
  if (abs >= 1000) return `${sign}$${trimScaled(abs / 1000)}k`;
  if (abs === 0) return "$0";
  // Axis steps are "nice" numbers, so most ticks are whole dollars: printing
  // `$80.0` there spends a character on a decimal that is always zero.
  if (Number.isInteger(abs)) return `${sign}$${abs}`;
  if (abs < 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(1)}`;
}

function trimScaled(scaled: number): string {
  if (scaled >= 100) return String(Math.round(scaled));
  const rounded = Math.round(scaled * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** `31.5B` — the sidebar badge's compact shape, reused so counts read alike. */
export { formatTokens };

/** `3,337` — session counts and other exact integers. */
export function formatCount(value: number): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}

/** `36.1%`. Below a tenth of a percent, say so rather than printing `0.0%`. */
export function formatPercent(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  if (share > 0 && share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

/** The active metric's figure, in that metric's units. */
export function formatMetric(value: number, metric: "cost" | "tokens"): string {
  return metric === "cost" ? formatUsd(value) : formatTokens(value);
}

/**
 * `Intl` throws on a time zone it does not recognise, and the zone reaches us
 * from the backend rather than from a literal. Falling back to the host zone
 * keeps a bad value from taking the whole page down with it.
 */
function dateFormat(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-US", options);
  }
}

function parseInstant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `AUG 19` for a day bucket, `14:00` for an hour one — the axis carries the
 * unit the buckets are in, so a 24h chart never claims to show days.
 */
export function formatBucketLabel(
  bucketStart: string,
  resolution: UsageResolution,
  timeZone: string
): string {
  const at = parseInstant(bucketStart);
  if (!at) return "";
  if (resolution === "hour") {
    return dateFormat(timeZone, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  }
  return dateFormat(timeZone, { month: "short", day: "numeric" }).format(at).toUpperCase();
}

/** The tooltip's fuller stamp: `Aug 19` or `Aug 19, 14:00`. */
export function formatBucketTitle(
  bucketStart: string,
  resolution: UsageResolution,
  timeZone: string
): string {
  const at = parseInstant(bucketStart);
  if (!at) return "";
  if (resolution === "hour") {
    return dateFormat(timeZone, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(at);
  }
  return dateFormat(timeZone, { month: "short", day: "numeric", year: "numeric" }).format(at);
}

/**
 * `Aug 4 to Sep 2` — the window written out, under the page title.
 * `rangeEnd` is exclusive, so the label names the last instant inside the
 * window rather than the first one outside it.
 */
export function formatRangeLabel(
  rangeStart: string,
  rangeEnd: string,
  resolution: UsageResolution,
  timeZone: string
): string {
  const start = parseInstant(rangeStart);
  const end = parseInstant(rangeEnd);
  if (!start || !end) return "";
  const lastInside = new Date(end.getTime() - 1);
  if (resolution === "hour") {
    const stamp = dateFormat(timeZone, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    return `${stamp.format(start)} to ${stamp.format(end)}`;
  }
  const day = dateFormat(timeZone, { month: "short", day: "numeric" });
  return `${day.format(start)} to ${day.format(lastInside)}`;
}

/** `Sep 3, 14:02` — when the numbers were last refreshed from disk. */
export function formatScanStamp(value: string | null, timeZone: string): string | null {
  if (!value) return null;
  const at = parseInstant(value);
  if (!at) return null;
  return dateFormat(timeZone, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(at);
}

/** `Sep 3, 2026` — the date the pricing table was last checked. */
export function formatPricingDate(value: string, timeZone: string): string {
  const at = parseInstant(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!at) return value;
  return dateFormat(timeZone, { month: "short", day: "numeric", year: "numeric" }).format(at);
}
