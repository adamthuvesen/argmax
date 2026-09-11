import { formatCount, formatPercent } from "../usage/usageFormat.js";
import type { ActivityResolution } from "./activityContract.js";

/**
 * Number and date shapes for the Activity page. Counts and percentages come
 * straight from the Usage page's helpers — the two pages sit side by side
 * under one rail, and a commit count that reads differently from a session
 * count would be a seam between them.
 *
 * Everything here is set in tabular numerals by `.activity-main`, so widths
 * are chosen to line up down a column rather than to be as short as possible.
 */

export { formatCount, formatPercent };

/** `48.2k` — the axis tick and the compact line figure. */
export function formatCompact(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  const sign = safe < 0 ? "−" : "";
  if (abs >= 999_500) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1000) return `${sign}${trim(abs / 1000)}k`;
  return `${sign}${Math.round(abs)}`;
}

function trim(scaled: number): string {
  if (scaled >= 100) return String(Math.round(scaled));
  const rounded = Math.round(scaled * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * `+6,412` and `−2,988`. A real minus sign rather than a hyphen: the two
 * figures sit next to each other in one cell, and a hyphen at this size reads
 * as a dash joining them.
 */
export function formatAdded(value: number): string {
  return `+${formatCount(Math.abs(value))}`;
}

export function formatRemoved(value: number): string {
  return `−${formatCount(Math.abs(value))}`;
}

/**
 * `18%`, `2.4%`, `<0.1%`. A delta is a comparison rather than a measurement,
 * so it drops to whole percents as soon as the decimal stops carrying
 * anything. Same shape as the Usage hero's chip.
 */
export function formatDeltaRatio(ratio: number): string {
  const magnitude = Math.abs(ratio) * 100;
  if (!Number.isFinite(magnitude)) return "—";
  if (magnitude === 0) return "0%";
  if (magnitude < 0.1) return "<0.1%";
  if (magnitude >= 10) return `${Math.round(magnitude)}%`;
  return `${magnitude.toFixed(1)}%`;
}

/**
 * `48m`, `5h 12m`, `6h`, `1d 19h`. Two units at most: a cycle time is read to
 * decide whether a review took an afternoon or a week, and the third unit
 * never changes that answer.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * `Intl` throws on a zone it does not recognise, and the zone reaches us from
 * the backend rather than from a literal. Falling back to the host zone keeps
 * a bad value from taking the whole page down with it.
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
 * A `YYYY-MM-DD` calendar date as a local `Date`. Parsed field by field rather
 * than through `new Date(string)`, which reads a bare date as UTC midnight and
 * lands on the previous day for every reader west of Greenwich — which would
 * shift the whole heatmap by one column.
 */
export function parseCalendarDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `Aug 25` from a `YYYY-MM-DD` calendar date. */
export function formatCalendarDate(date: string | null): string {
  if (!date) return "—";
  const at = parseCalendarDate(date);
  if (!at) return date;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(at);
}

/** `Aug 25, 2026` — the heatmap cell's own title, where the year matters. */
export function formatCalendarDateLong(date: string): string {
  const at = parseCalendarDate(date);
  if (!at) return date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(at);
}

/** `Sep 1` — an instant as a bare day. */
export function formatShortDate(value: string | null, timeZone: string): string {
  if (!value) return "—";
  const at = parseInstant(value);
  if (!at) return "—";
  return dateFormat(timeZone, { month: "short", day: "numeric" }).format(at);
}

/**
 * `2h ago`, `yesterday`, `3d ago`, `2w ago`, then a date once "ago" stops
 * being the useful phrase. The last-commit column is scanned for which
 * repositories are warm, so recency reads before precision does.
 */
export function formatSince(value: string | null, timeZone: string, now: Date = new Date()): string {
  if (!value) return "—";
  const at = parseInstant(value);
  if (!at) return "—";
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 28) return `${Math.round(days / 7)}w ago`;
  return dateFormat(timeZone, { month: "short", day: "numeric" }).format(at);
}

/**
 * `14:00` for an hour bucket, `AUG 4` for a day or a week — the axis carries
 * the unit its buckets are in, so a 24h chart never claims to show days and a
 * 12-month chart never claims to show one.
 */
export function formatBucketLabel(
  bucketStart: string,
  resolution: ActivityResolution,
  timeZone: string
): string {
  const at = parseInstant(bucketStart);
  if (!at) return "";
  if (resolution === "hour") {
    return dateFormat(timeZone, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  }
  if (resolution === "week") {
    return dateFormat(timeZone, { month: "short" }).format(at).toUpperCase();
  }
  return dateFormat(timeZone, { month: "short", day: "numeric" }).format(at).toUpperCase();
}

/** The tooltip's fuller stamp: `Aug 19, 14:00`, `Aug 19, 2026`, `Week of Aug 19`. */
export function formatBucketTitle(
  bucketStart: string,
  resolution: ActivityResolution,
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
  const day = dateFormat(timeZone, { month: "short", day: "numeric", year: "numeric" }).format(at);
  return resolution === "week" ? `Week of ${day}` : day;
}

/**
 * `Aug 4 to Sep 2` — the window written out, under the page title. `rangeEnd`
 * is exclusive, so the label names the last instant inside the window rather
 * than the first one outside it. A window that straddles a new year carries
 * the years, because "Sep 8 to Sep 2" reads as a mistake without them.
 */
export function formatRangeLabel(
  rangeStart: string,
  rangeEnd: string,
  resolution: ActivityResolution,
  timeZone: string
): string {
  const start = parseInstant(rangeStart);
  const end = parseInstant(rangeEnd);
  if (!start || !end) return "";
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
  const lastInside = new Date(end.getTime() - 1);
  const year = dateFormat(timeZone, { year: "numeric" });
  const spansYears = year.format(start) !== year.format(lastInside);
  const day = dateFormat(
    timeZone,
    spansYears
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" }
  );
  return `${day.format(start)} to ${day.format(lastInside)}`;
}

/** `Sep 3, 14:02` — when the repositories were last walked. */
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

/**
 * The hero numeral: `842,190` in full, `5.17M` once it would not fit.
 *
 * The hero column is a fixed 236px and the figure is set at 64px, which holds
 * six digits and their comma. A seventh digit pushed the numeral across the
 * rule and over the heatmap beside it, so from a million upward the figure
 * switches to three significant digits — enough that `5.17M` and `5.23M` still
 * read as different numbers, which a one-decimal `5.2M` would not.
 */
export function formatHeroCount(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  if (abs < 999_500) return formatCount(Math.round(safe));
  const sign = safe < 0 ? "−" : "";
  if (abs < 999_500_000) return `${sign}${significant(abs / 1_000_000)}M`;
  return `${sign}${significant(abs / 1_000_000_000)}B`;
}

/** Three significant digits: `5.17`, `12.3`, `123`. */
function significant(scaled: number): string {
  if (scaled >= 100) return String(Math.round(scaled));
  const places = scaled >= 10 ? 1 : 2;
  const rounded = Math.round(scaled * 10 ** places) / 10 ** places;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(places);
}
