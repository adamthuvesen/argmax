import type {
  ActivityCadence,
  ActivityRepository,
  ActivitySummary,
  ActivityTotals,
  ActivityWindow
} from "./activityContract.js";

/** The measure the page is showing: commits, or lines touched. */
export type ActivityMetric = "commits" | "lines";

export const ACTIVITY_METRIC_OPTIONS = [
  { value: "commits", label: "Commits" },
  { value: "lines", label: "Lines" }
];

/**
 * How many repositories get a colour of their own. Five, because that is how
 * many series tokens `tokens.css` carries — the Usage page's provider palette,
 * validated for CVD separation on both surfaces in both themes. Everything
 * past the fifth is one `--muted` tail rather than a sixth colour nobody can
 * tell from the fifth.
 */
export const ACTIVITY_SERIES_SLOTS = 5;

/** The tail's series key, kept out of the project-id namespace. */
export const ACTIVITY_TAIL_KEY = "__tail";

export type ActivitySlot = "1" | "2" | "3" | "4" | "5" | "tail";

/**
 * Anything with lines and commits on it: totals, a repository row, one
 * repository's slice of one bucket. All three answer the metric switch the
 * same way, so they share one accessor.
 */
type ActivityAmounts = { commits: number; linesAdded: number; linesRemoved: number };

/**
 * What a row contributes to the active metric. Lines are counted as churn —
 * added plus removed — because that is the figure a bar can carry: a net line
 * count goes negative on a deletion week and a stacked area cannot draw it.
 * The signed pair is still printed beside every churn figure.
 */
export function metricValue(row: ActivityAmounts, metric: ActivityMetric): number {
  return metric === "commits" ? row.commits : row.linesAdded + row.linesRemoved;
}

/** `commits` / `lines changed` — how a sentence names the active metric. */
export function metricNoun(value: number, metric: ActivityMetric): string {
  if (metric === "lines") return "lines changed";
  return value === 1 ? "commit" : "commits";
}

/**
 * The five windows the page offers. The calendar year takes the year as an
 * argument rather than reading the clock itself: a component that renamed its
 * own option would be a second source of truth for "now", and the fixture
 * runs on a pinned date.
 */
export function activityWindowOptions(
  year: number
): ReadonlyArray<{ value: ActivityWindow; label: string }> {
  return [
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "12m", label: "Last 12 months" },
    { value: "year", label: String(year) }
  ];
}

/** What the delta chip is comparing against, said in words. */
const PREVIOUS_LABEL: Record<ActivityWindow, string> = {
  "24h": "the previous 24 hours",
  "7d": "the previous 7 days",
  "30d": "the previous 30 days",
  "12m": "the previous 12 months",
  // The backend compares a part-year against the same number of days before
  // Jan 1, not against last year's same months.
  year: "the same span before Jan 1"
};

export interface ActivityDelta {
  direction: "up" | "down" | "flat";
  /** The size of the change as a fraction: `0.184` is 18.4%. */
  ratio: number;
  previousLabel: string;
}

/**
 * This window against the one before it. The backend returns `previous` as
 * `null` when the ledger does not reach back that far, and a period that
 * recorded nothing is not a baseline — a first week would otherwise read as
 * an infinite rise off zero.
 */
export function windowDelta(summary: ActivitySummary, metric: ActivityMetric): ActivityDelta | null {
  const previous: ActivityTotals | null = summary.previous;
  if (!previous) return null;
  const before = metricValue(previous, metric);
  const now = metricValue(summary.totals, metric);
  if (!(before > 0) || !Number.isFinite(now)) return null;
  const ratio = (now - before) / before;
  // Under a percent either way is noise, not a trend.
  const direction = Math.abs(ratio) < 0.01 ? "flat" : ratio > 0 ? "up" : "down";
  return { direction, ratio, previousLabel: PREVIOUS_LABEL[summary.window] };
}

/**
 * A repository's colour follows its rank *by commits*, never by the active
 * metric: the backend already ranks `repositories` that way, so the terracotta
 * slot stays on the same repository when the Commits/Lines switch reorders the
 * table under it. That is as close as a page whose rows have no fixed identity
 * can get to the Usage page's rule that colour names the series, not its
 * position (docs/styling.md).
 */
export function repositorySlots(
  repositories: readonly ActivityRepository[]
): Map<string, ActivitySlot> {
  const slots = new Map<string, ActivitySlot>();
  repositories.forEach((repo, index) => {
    slots.set(
      repo.projectId,
      index < ACTIVITY_SERIES_SLOTS ? (String(index + 1) as ActivitySlot) : "tail"
    );
  });
  return slots;
}

export interface ActivityChartSeries {
  /** A project id, or `ACTIVITY_TAIL_KEY` for the pooled remainder. */
  key: string;
  label: string;
  slot: ActivitySlot;
  /** One value per bucket, in the series' own order. */
  values: number[];
}

/**
 * The curves the chart draws, biggest first. Repositories past the fifth are
 * pooled into one tail series: six overlaid areas in five colours is a lie
 * about which is which, and a flat zero line for a repository that did nothing
 * in the window is noise the reader has to look past.
 */
export function chartSeries(
  summary: ActivitySummary,
  metric: ActivityMetric
): ActivityChartSeries[] {
  const slots = repositorySlots(summary.repositories);
  const named = summary.repositories.slice(0, ACTIVITY_SERIES_SLOTS);
  const buckets = summary.series.length;
  const zeros = (): number[] => new Array<number>(buckets).fill(0);

  const series = named.map((repo) => ({
    key: repo.projectId,
    label: repo.name,
    slot: slots.get(repo.projectId) ?? "tail",
    values: zeros()
  }));
  const byKey = new Map(series.map((entry) => [entry.key, entry]));
  const tail: ActivityChartSeries = {
    key: ACTIVITY_TAIL_KEY,
    label: "",
    slot: "tail",
    values: zeros()
  };
  const tailProjects = new Set<string>();

  summary.series.forEach((point, index) => {
    for (const slice of point.byRepository) {
      const value = metricValue(slice, metric);
      if (value <= 0) continue;
      const entry = byKey.get(slice.projectId);
      if (entry) {
        entry.values[index] += value;
        continue;
      }
      tail.values[index] += value;
      tailProjects.add(slice.projectId);
    }
  });

  const moved = series.filter((entry) => entry.values.some((value) => value > 0));
  if (tailProjects.size === 0) return moved;
  tail.label = `${tailProjects.size} ${tailProjects.size === 1 ? "other" : "others"}`;
  return [...moved, tail];
}

/** Monday first, so a week reads left to right the way the cadence chart draws it. */
export const ACTIVITY_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];

export interface ActivityPeak {
  index: number;
  label: string;
  value: number;
}

/** The busiest weekday, or null when nothing landed at all. */
export function peakWeekday(cadence: ActivityCadence): ActivityPeak | null {
  return peakOf(cadence.byWeekday, (index) => WEEKDAY_NAMES[index] ?? "");
}

/** The busiest hour, named as the hour it opens: `10:00`. */
export function peakHour(cadence: ActivityCadence): ActivityPeak | null {
  return peakOf(cadence.byHour, (index) => `${String(index).padStart(2, "0")}:00`);
}

function peakOf(values: readonly number[], label: (index: number) => string): ActivityPeak | null {
  let bestIndex = -1;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!(value > 0)) continue;
    // Ties keep the earlier slot: "peak Tuesday" beats "peak Thursday" when
    // the two are level, because the week reads forward.
    if (bestIndex >= 0 && values[bestIndex] >= value) continue;
    bestIndex = index;
  }
  if (bestIndex < 0) return null;
  return { index: bestIndex, label: label(bestIndex), value: values[bestIndex] };
}

/** The widest span the reading is willing to call "when the work lands". */
const WEEKDAY_SPAN = 3;
const HOUR_SPAN = 4;

/**
 * One sentence under the two small multiples: which days and hours carry the
 * work, and what the weekend costs. Both charts are already on the page, so
 * this says the thing the bars cannot — which of them is the pattern.
 */
export function cadenceReading(cadence: ActivityCadence): string | null {
  const total = cadence.byWeekday.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const days = densestSpan(cadence.byWeekday, WEEKDAY_SPAN);
  const hours = densestSpan(cadence.byHour, HOUR_SPAN);
  const dayPhrase = `${ACTIVITY_WEEKDAYS[days]}–${ACTIVITY_WEEKDAYS[days + WEEKDAY_SPAN - 1]}`;
  const hourPhrase = `${String(hours).padStart(2, "0")}:00–${String(hours + HOUR_SPAN - 1).padStart(2, "0")}:00`;
  const weekend = (cadence.byWeekday[5] ?? 0) + (cadence.byWeekday[6] ?? 0);
  const weekendShare = Math.round((weekend / total) * 100);
  return `Most of the work lands ${dayPhrase}, ${hourPhrase}. Weekends carry ${weekendShare}% of it.`;
}

/** The start index of the densest run of `span` consecutive values. */
function densestSpan(values: readonly number[], span: number): number {
  let bestStart = 0;
  let bestSum = -1;
  for (let start = 0; start + span <= values.length; start += 1) {
    let sum = 0;
    for (let offset = 0; offset < span; offset += 1) sum += values[start + offset] ?? 0;
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  return bestStart;
}

/**
 * A share as a bar width in the bar's own 0–100 space. A repository that did
 * anything at all keeps a visible sliver rather than rounding away to nothing
 * — the floor the Usage page's share meters use.
 */
export function barWidth(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(100, Math.max(0.8, share * 100));
}
