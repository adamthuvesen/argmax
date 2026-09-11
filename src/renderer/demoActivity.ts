import type {
  ActivityCadence,
  ActivityHeatmapDay,
  ActivityPullRequest,
  ActivityRepository,
  ActivityResolution,
  ActivityReview,
  ActivitySeriesPoint,
  ActivityStreaks,
  ActivitySummary,
  ActivitySummaryInput,
  ActivityTotals,
  ActivityWindow
} from "./components/activity/activityContract.js";

/**
 * Demo activity for the browser-preview boot, where there is no Rust backend
 * to walk anyone's clones. Deterministic: the same window always yields the
 * same numbers, so a screenshot diff is a real change rather than fresh noise.
 *
 * Like `demoUsage`, this module is only ever reached through a dynamic import
 * from the no-bridge path, so Vite keeps it out of the packaged renderer
 * bundle. Everything is derived from one synthetic commit log rather than from
 * per-card literals — the hero, the chart, the heatmap, the streaks and the
 * cadence all have to agree, and five hand-written totals never do.
 */

/**
 * A fixed calendar instant rather than a fixed epoch: day buckets are cut on
 * local midnight, so anchoring in UTC would put the last bucket a day off the
 * range label everywhere east of Greenwich. `END` is exclusive, so the last
 * day inside every window is Sep 2, 2026.
 */
const END = new Date(2026, 8, 3, 0, 0, 0);
/** Enough history for a 12-month window *and* the 12 months it compares with. */
const HISTORY_DAYS = 800;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `?activity=…` puts the page into one of its other states from the URL. */
export type DemoActivityState = "normal" | "empty" | "scanning" | "nogh";

function urlState(): DemoActivityState {
  if (typeof window === "undefined") return "normal";
  const flag = new URLSearchParams(window.location.search).get("activity");
  return flag === "empty" || flag === "scanning" || flag === "nogh" ? flag : "normal";
}

/** Cheap deterministic noise. Same seed, same log, every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoRepo {
  projectId: string;
  name: string;
  path: string;
  githubRepo: string | null;
  /** Mean commits a day before the weekly rhythm, the ramp, and the spike. */
  base: number;
}

const REPOS: readonly DemoRepo[] = [
  { projectId: "p-argmax", name: "argmax", path: "~/dev/menti/argmax", githubRepo: "adamthuvesen/argmax", base: 2.2 },
  { projectId: "p-dbt", name: "dbt-transform", path: "~/dev/menti/dbt-transform", githubRepo: "mentimeter/dbt-transform", base: 1.25 },
  { projectId: "p-pat", name: "product-analytics-tools", path: "~/dev/menti/product-analytics-tools", githubRepo: "mentimeter/product-analytics-tools", base: 0.9 },
  { projectId: "p-alfred", name: "alfred", path: "~/dev/alfred", githubRepo: "adamthuvesen/alfred", base: 0.6 },
  { projectId: "p-dotfiles", name: "dotfiles", path: "~/dotfiles", githubRepo: "adamthuvesen/dotfiles", base: 0.42 },
  { projectId: "p-revops", name: "revops-backoffice", path: "~/dev/menti/revops-backoffice", githubRepo: "mentimeter/revops-backoffice", base: 0.3 },
  { projectId: "p-hexops", name: "hex-agent-ops", path: "~/dev/menti/hex-agent-ops", githubRepo: "mentimeter/hex-agent-ops", base: 0.24 },
  { projectId: "p-llm", name: "llm-infer", path: "~/dev/llm-infer", githubRepo: "adamthuvesen/llm-infer", base: 0.17 },
  { projectId: "p-scenario", name: "scenario-model", path: "~/dev/menti/scenario-model", githubRepo: "mentimeter/scenario-model", base: 0.13 },
  { projectId: "p-ntfy", name: "ntfy-bridge", path: "~/dev/ntfy-bridge", githubRepo: null, base: 0.1 },
  { projectId: "p-engram", name: "engram", path: "~/dev/engram", githubRepo: "adamthuvesen/engram", base: 0.07 },
  { projectId: "p-trace", name: "trace-index", path: "~/dev/trace-index", githubRepo: null, base: 0.05 }
];

/** A working week: quiet at the ends, busiest on Tuesday. Monday first. */
const WEEKDAY_SHAPE = [1, 1.16, 1.05, 0.95, 0.88, 0.44, 0.34];
/** When commits land, by local hour. Weights, not counts. */
const HOUR_SHAPE = [0, 0, 0, 0, 0, 1, 2, 5, 11, 17, 21, 18, 9, 12, 16, 15, 13, 11, 8, 7, 6, 6, 4, 2];
const HOUR_TOTAL = HOUR_SHAPE.reduce((sum, weight) => sum + weight, 0);

/**
 * How many trailing days are forced busy, so the fixture has a current streak
 * to show. The day before it is forced off, which is what makes the streak
 * exactly this long rather than "however far back the noise happens to run".
 */
const FORCED_STREAK_DAYS = 14;
/** …and one long run earlier in the year, so "longest" is not just this one. */
const LONG_STREAK_START = new Date(2026, 1, 2).getTime();
const LONG_STREAK_END = new Date(2026, 2, 4).getTime();

/** The one day the fixture leans on: a long migration weekend. */
const SPIKE = new Date(2026, 7, 25).getTime();
/** …and the two repositories it landed in. */
const SPIKE_REPOS = new Set(["p-argmax", "p-dbt"]);

interface DemoCommit {
  /** Local instant the commit landed. */
  at: number;
  projectId: string;
  added: number;
  removed: number;
  files: number;
}

/**
 * One intensity per day, shared by every repository, because a quiet day is
 * quiet everywhere: a per-repo roll averages out into twelve repositories each
 * committing their mean every single day, which draws a heatmap of one colour
 * and a streak that never breaks.
 *
 * Zero is a day off. Weekends take most of them, and the trailing fortnight is
 * forced busy so the fixture has a streak to show.
 */
function dayIntensities(): number[] {
  const rand = mulberry32(0x5f37_59df);
  const firstDay = new Date(END.getFullYear(), END.getMonth(), END.getDate() - HISTORY_DAYS);
  const factors: number[] = [];
  for (let day = 0; day < HISTORY_DAYS; day += 1) {
    const at = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + day);
    const weekend = (at.getDay() + 6) % 7 >= 5;
    const streakEdge = HISTORY_DAYS - 1 - FORCED_STREAK_DAYS;
    const roll = rand();
    const spread = rand();
    // A forced day needs a floor rather than merely a non-zero factor: twelve
    // repositories each rolling under their own mean still leaves the day at
    // zero commits, which breaks the streak the floor exists to guarantee.
    const forced =
      day > streakEdge ||
      (at.getTime() >= LONG_STREAK_START && at.getTime() <= LONG_STREAK_END);
    if (forced) {
      factors.push(1.1 + 1.1 * spread);
      continue;
    }
    // The day either side of a forced run is off, so the run is exactly as
    // long as it says rather than however far the noise happens to extend it.
    const edge =
      day === streakEdge ||
      at.getTime() === LONG_STREAK_START - DAY_MS ||
      at.getTime() === LONG_STREAK_END + DAY_MS;
    if (edge || roll < (weekend ? 0.42 : 0.06)) {
      factors.push(0);
      continue;
    }
    // Heavy-tailed rather than uniform: most days are ordinary and a few are
    // the ones the heatmap's top step exists for.
    factors.push(0.4 + 2.1 * spread ** 1.9);
  }
  return factors;
}

let cachedLog: DemoCommit[] | null = null;

/**
 * One synthetic commit per entry, ordered oldest first. Built once: every card
 * on the page is an aggregation over this list, which is what makes the hero,
 * the heatmap and the cadence agree by construction.
 */
function commitLog(): DemoCommit[] {
  if (cachedLog) return cachedLog;
  const log: DemoCommit[] = [];
  const firstDay = new Date(END.getFullYear(), END.getMonth(), END.getDate() - HISTORY_DAYS);
  const intensity = dayIntensities();
  REPOS.forEach((repo, order) => {
    const rand = mulberry32(0x2026_0903 ^ (order * 2654435761));
    for (let day = 0; day < HISTORY_DAYS; day += 1) {
      const at = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + day);
      // Monday-first weekday: JS puts Sunday at 0.
      const weekday = (at.getDay() + 6) % 7;
      const position = day / (HISTORY_DAYS - 1);
      const ramp = 0.72 + 0.56 * position;
      const spike = at.getTime() === SPIKE && SPIKE_REPOS.has(repo.projectId) ? 3.2 : 1;
      const expected = repo.base * WEEKDAY_SHAPE[weekday] * ramp * spike * intensity[day];
      const count = Math.floor(expected + rand());
      for (let index = 0; index < count; index += 1) {
        const hour = pickHour(rand());
        const minute = Math.floor(rand() * 60);
        const size = 18 + Math.floor(rand() ** 2.1 * 520);
        log.push({
          at: at.getTime() + hour * HOUR_MS + minute * 60_000,
          projectId: repo.projectId,
          added: size,
          removed: Math.round(size * (0.18 + rand() * 0.62)),
          files: 1 + Math.floor(rand() * 9)
        });
      }
    }
  });
  log.sort((left, right) => left.at - right.at);
  cachedLog = log;
  return log;
}

/** An hour drawn from `HOUR_SHAPE` by its cumulative weight. */
function pickHour(roll: number): number {
  let remaining = roll * HOUR_TOTAL;
  for (let hour = 0; hour < HOUR_SHAPE.length; hour += 1) {
    remaining -= HOUR_SHAPE[hour];
    if (remaining <= 0) return hour;
  }
  return HOUR_SHAPE.length - 1;
}

/** `2026-08-25` in local time — the key the heatmap and the streaks agree on. */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyTotals(): ActivityTotals {
  return {
    commits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
    activeDays: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    reviewsGiven: 0,
    reviewApprovals: 0,
    reviewChangesRequested: 0,
    reviewComments: 0
  };
}

interface DemoRange {
  start: number;
  end: number;
  resolution: ActivityResolution;
  /** The same-length span immediately before, for `previous`. */
  previousStart: number;
}

function rangeFor(window: ActivityWindow): DemoRange {
  const end = END.getTime();
  const startOfDay = (offset: number): number =>
    new Date(END.getFullYear(), END.getMonth(), END.getDate() + offset).getTime();
  switch (window) {
    case "24h":
      return { start: end - 24 * HOUR_MS, end, resolution: "hour", previousStart: end - 48 * HOUR_MS };
    case "7d":
      return { start: startOfDay(-7), end, resolution: "day", previousStart: startOfDay(-14) };
    case "30d":
      return { start: startOfDay(-30), end, resolution: "day", previousStart: startOfDay(-60) };
    case "12m": {
      const start = new Date(END.getFullYear() - 1, END.getMonth(), END.getDate()).getTime();
      const previousStart = new Date(END.getFullYear() - 2, END.getMonth(), END.getDate()).getTime();
      return { start, end, resolution: "week", previousStart };
    }
    default: {
      // The calendar year so far, compared with the same number of days
      // before Jan 1 rather than with last year's same months.
      const start = new Date(END.getFullYear(), 0, 1).getTime();
      const days = Math.round((end - start) / DAY_MS);
      const previousStart = new Date(END.getFullYear() - 1, 0, 1 + (365 - days)).getTime();
      return { start, end, resolution: "week", previousStart };
    }
  }
}

/** The bucket boundaries a range is cut on, oldest first. */
function bucketStarts(range: DemoRange): number[] {
  const starts: number[] = [];
  if (range.resolution === "hour") {
    for (let at = range.start; at < range.end; at += HOUR_MS) starts.push(at);
    return starts;
  }
  if (range.resolution === "day") {
    for (let at = range.start; at < range.end; at += DAY_MS) starts.push(at);
    return starts;
  }
  // Weeks start Monday, so the first bucket opens on or before the range.
  const first = new Date(range.start);
  const back = (first.getDay() + 6) % 7;
  let cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate() - back).getTime();
  while (cursor < range.end) {
    starts.push(cursor);
    const at = new Date(cursor);
    cursor = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 7).getTime();
  }
  return starts;
}

function totalsFrom(commits: readonly DemoCommit[]): ActivityTotals {
  const totals = emptyTotals();
  const days = new Set<string>();
  for (const commit of commits) {
    totals.commits += 1;
    totals.linesAdded += commit.added;
    totals.linesRemoved += commit.removed;
    totals.filesChanged += commit.files;
    days.add(dayKey(commit.at));
  }
  totals.activeDays = days.size;
  return totals;
}

function seriesFrom(commits: readonly DemoCommit[], range: DemoRange): ActivitySeriesPoint[] {
  const starts = bucketStarts(range);
  const step = range.resolution === "hour" ? HOUR_MS : range.resolution === "day" ? DAY_MS : 7 * DAY_MS;
  const buckets = starts.map(() => new Map<string, { commits: number; linesAdded: number; linesRemoved: number }>());
  for (const commit of commits) {
    const index = Math.min(starts.length - 1, Math.floor((commit.at - starts[0]) / step));
    if (index < 0) continue;
    const bucket = buckets[index];
    const slice = bucket.get(commit.projectId) ?? { commits: 0, linesAdded: 0, linesRemoved: 0 };
    slice.commits += 1;
    slice.linesAdded += commit.added;
    slice.linesRemoved += commit.removed;
    bucket.set(commit.projectId, slice);
  }
  return starts.map((start, index) => ({
    bucketStart: new Date(start).toISOString(),
    byRepository: [...buckets[index].entries()].map(([projectId, slice]) => ({ projectId, ...slice }))
  }));
}

function heatmapFrom(log: readonly DemoCommit[]): ActivityHeatmapDay[] {
  const perDay = new Map<string, number>();
  for (const commit of log) {
    const key = dayKey(commit.at);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const days: ActivityHeatmapDay[] = [];
  // The 365 days ending on the last day inside the range (Sep 2).
  for (let offset = 364; offset >= 0; offset -= 1) {
    const at = new Date(END.getFullYear(), END.getMonth(), END.getDate() - 1 - offset);
    const key = dayKey(at.getTime());
    days.push({ date: key, commits: perDay.get(key) ?? 0 });
  }
  return days;
}

function streaksFrom(
  heatmap: readonly ActivityHeatmapDay[],
  windowed: readonly DemoCommit[]
): ActivityStreaks {
  let current = 0;
  let currentStart: string | null = null;
  for (let index = heatmap.length - 1; index >= 0; index -= 1) {
    if (heatmap[index].commits <= 0) break;
    current += 1;
    currentStart = heatmap[index].date;
  }
  let longest = 0;
  let longestStart: string | null = null;
  let longestEnd: string | null = null;
  let run = 0;
  let runStart: string | null = null;
  for (const day of heatmap) {
    if (day.commits > 0) {
      run += 1;
      runStart ??= day.date;
      if (run > longest) {
        longest = run;
        longestStart = runStart;
        longestEnd = day.date;
      }
      continue;
    }
    run = 0;
    runStart = null;
  }
  const perDay = new Map<string, number>();
  for (const commit of windowed) {
    const key = dayKey(commit.at);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  let busiestDay: ActivityStreaks["busiestDay"] = null;
  for (const [date, commits] of perDay) {
    if (!busiestDay || commits > busiestDay.commits) busiestDay = { date, commits };
  }
  return { currentDays: current, currentStart, longestDays: longest, longestStart, longestEnd, busiestDay };
}

function cadenceFrom(commits: readonly DemoCommit[]): ActivityCadence {
  const byWeekday = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  for (const commit of commits) {
    const at = new Date(commit.at);
    byWeekday[(at.getDay() + 6) % 7] += 1;
    byHour[at.getHours()] += 1;
  }
  return { byWeekday, byHour };
}

const PR_TITLES: readonly string[] = [
  "feat(session): launch into a named branch or existing worktree",
  "fix(renderer): load every lazy chunk through importChunk",
  "Add cycle-time mart for PR analytics",
  "fix(review): drop the changes-tab commit dialog and use stage icons",
  "Scenario model: cohort retention inputs",
  "Weekly digest routine",
  "Migrate zsh prompt to starship",
  "feat(goals): per-turn evaluator strip in the checks lane",
  "fct_sessions: backfill engagement_score",
  "Snowflake warm-up before every dbt invocation",
  "perf(chat): stop remounting the pane on a session switch",
  "fix(usage): keep the ledger up when remaining usage fails",
  "Rebuild fct_sessions incremental strategy",
  "Cursor ACP: match model by family",
  "ntfy: ASCII-only titles",
  "feat(remote): reserve the composer inset on iOS standalone",
  "chore(ci): shard the vitest suite eight ways",
  "fix(heatmap): parse calendar dates field by field",
  "Retire the pixel-field constants duplicated in the sweep",
  "feat(activity): rank repositories onto the series palette"
];

const REVIEW_TITLES: readonly string[] = [
  "Rebuild fct_sessions incremental strategy",
  "Cursor ACP: match model by family",
  "Snowflake warmup before dbt",
  "ntfy: ASCII-only titles",
  "Trim the dashboard delta payload",
  "Guard the stale-write path with a serde tag",
  "Move the reader pool off the main thread",
  "Backfill the routine run history",
  "Drop the recurring renderer poll",
  "Name the old checksum before rebuilding the migration"
];

let cachedPrs: ActivityPullRequest[] | null = null;

/** A PR's opening instant, the field every window filter is cut on. */
function openedAt(pr: ActivityPullRequest): number {
  return new Date(pr.createdAt).getTime();
}

/**
 * Pull requests over the whole history, so every window can filter the same
 * list. Cycle times are drawn short-tailed on purpose: the ledger's footer
 * quotes a median and a p90, and a uniform spread makes the two identical.
 */
function pullRequestLog(): ActivityPullRequest[] {
  if (cachedPrs) return cachedPrs;
  const rand = mulberry32(0x9e37_79b9);
  const prs: ActivityPullRequest[] = [];
  const firstDay = new Date(END.getFullYear(), END.getMonth(), END.getDate() - HISTORY_DAYS);
  let number = 812;
  for (let day = 0; day < HISTORY_DAYS; day += 1) {
    const at = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + day);
    const weekday = (at.getDay() + 6) % 7;
    const expected = 0.62 * WEEKDAY_SHAPE[weekday] * (0.7 + 0.6 * (day / (HISTORY_DAYS - 1)));
    const count = Math.floor(expected + rand());
    for (let index = 0; index < count; index += 1) {
      const repo = REPOS[Math.floor(rand() ** 1.7 * 6)] ?? REPOS[0];
      const createdMs = at.getTime() + (9 + Math.floor(rand() * 9)) * HOUR_MS + Math.floor(rand() * 60) * 60_000;
      // Short-tailed: most merge the same day, a few sit for days.
      const cycleSeconds = Math.round(900 + rand() ** 3.4 * 320_000);
      // Either still inside its cycle, or one of the few that stalled: a
      // ledger with no open row never exercises the open state's colour, its
      // "so far" cycle, or the draft badge.
      const stillOpen = createdMs + cycleSeconds * 1000 >= END.getTime() || rand() < 0.08;
      const abandoned = !stillOpen && rand() < 0.06;
      const additions = 24 + Math.floor(rand() ** 2 * 1180);
      number += 1;
      prs.push({
        number,
        title: PR_TITLES[number % PR_TITLES.length],
        repository: repo.githubRepo ?? `adamthuvesen/${repo.name}`,
        projectId: repo.projectId,
        url: `https://github.com/${repo.githubRepo ?? `adamthuvesen/${repo.name}`}/pull/${number}`,
        state: stillOpen ? "open" : abandoned ? "closed" : "merged",
        isDraft: stillOpen && rand() < 0.2,
        createdAt: new Date(createdMs).toISOString(),
        mergedAt: stillOpen || abandoned ? null : new Date(createdMs + cycleSeconds * 1000).toISOString(),
        closedAt: abandoned ? new Date(createdMs + cycleSeconds * 1000).toISOString() : null,
        additions,
        deletions: Math.round(additions * (0.12 + rand() * 0.8)),
        cycleSeconds: stillOpen || abandoned ? null : cycleSeconds
      });
    }
  }
  cachedPrs = prs;
  return prs;
}

let cachedReviews: ActivityReview[] | null = null;

function reviewLog(): ActivityReview[] {
  if (cachedReviews) return cachedReviews;
  const rand = mulberry32(0x517c_c1b7);
  const reviews: ActivityReview[] = [];
  const firstDay = new Date(END.getFullYear(), END.getMonth(), END.getDate() - HISTORY_DAYS);
  let number = 401;
  for (let day = 0; day < HISTORY_DAYS; day += 1) {
    const at = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + day);
    const weekday = (at.getDay() + 6) % 7;
    const count = Math.floor(0.9 * WEEKDAY_SHAPE[weekday] + rand());
    for (let index = 0; index < count; index += 1) {
      const repo = REPOS[Math.floor(rand() ** 1.5 * 6)] ?? REPOS[0];
      const roll = rand();
      number += 1;
      reviews.push({
        number,
        title: REVIEW_TITLES[number % REVIEW_TITLES.length],
        repository: repo.githubRepo ?? `adamthuvesen/${repo.name}`,
        url: `https://github.com/${repo.githubRepo ?? `adamthuvesen/${repo.name}`}/pull/${number}`,
        state: roll < 0.7 ? "approved" : roll < 0.89 ? "changes_requested" : "commented",
        submittedAt: new Date(
          at.getTime() + (10 + Math.floor(rand() * 8)) * HOUR_MS + Math.floor(rand() * 60) * 60_000
        ).toISOString()
      });
    }
  }
  reviews.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  cachedReviews = reviews;
  return reviews;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The fixture the no-bridge path calls. `state` is only passed by tests; the
 * browser preview reads it off the URL so a screenshot run can capture the
 * empty, scanning, and signed-out states without a backend or a test double.
 */
export function demoActivitySummary(
  input: ActivitySummaryInput,
  state: DemoActivityState = urlState()
): ActivitySummary {
  const range = rangeFor(input.window);
  const log = commitLog();
  const scan: ActivitySummary["scan"] =
    state === "scanning"
      ? { phase: "scanning", reposTotal: REPOS.length, reposDone: 4, lastCompletedAt: null }
      : {
          phase: "idle",
          reposTotal: REPOS.length,
          reposDone: REPOS.length,
          lastCompletedAt: new Date(END.getTime() - 240_000).toISOString()
        };
  const github: ActivitySummary["github"] =
    state === "nogh"
      ? {
          available: false,
          login: null,
          error: "gh: not signed in to any GitHub hosts.",
          lastFetchedAt: null
        }
      : {
          available: true,
          login: "adamthuvesen",
          error: null,
          lastFetchedAt: new Date(END.getTime() - 90_000).toISOString()
        };

  const base: ActivitySummary = {
    window: input.window,
    projectId: input.projectId ?? null,
    timeZone: input.timeZone,
    rangeStart: new Date(range.start).toISOString(),
    rangeEnd: new Date(range.end).toISOString(),
    resolution: range.resolution,
    authorEmails: ["a.thuvesen@gmail.com", "adam@mentimeter.com"],
    scan,
    github,
    totals: emptyTotals(),
    previous: null,
    repositories: [],
    series: [],
    heatmap: [],
    streaks: {
      currentDays: 0,
      currentStart: null,
      longestDays: 0,
      longestStart: null,
      longestEnd: null,
      busiestDay: null
    },
    cadence: { byWeekday: new Array<number>(7).fill(0), byHour: new Array<number>(24).fill(0) },
    pullRequests: [],
    reviews: [],
    medianCycleSeconds: null
  };

  // No projects in the ledger at all: there is nothing to scan and nothing to
  // narrow, and the page says so rather than drawing twelve empty cards.
  if (state === "empty") return base;

  const inWindow = (at: number): boolean => at >= range.start && at < range.end;
  const matches = (projectId: string | null): boolean =>
    input.projectId === null || projectId === input.projectId;

  // `repositories` and `heatmap` never narrow: their point is the comparison a
  // filter would remove, the same rule the Usage page's provider tiles follow.
  const windowAll = log.filter((commit) => inWindow(commit.at));
  const windowTotal = windowAll.length;
  const perRepo = new Map<string, { commits: number; added: number; removed: number; last: number }>();
  for (const commit of windowAll) {
    const row = perRepo.get(commit.projectId) ?? { commits: 0, added: 0, removed: 0, last: 0 };
    row.commits += 1;
    row.added += commit.added;
    row.removed += commit.removed;
    row.last = Math.max(row.last, commit.at);
    perRepo.set(commit.projectId, row);
  }

  const windowed = windowAll.filter((commit) => matches(commit.projectId));
  const previousWindow = log.filter(
    (commit) =>
      commit.at >= range.previousStart && commit.at < range.start && matches(commit.projectId)
  );

  const prs = pullRequestLog().filter((pr) => {
    if (!matches(pr.projectId)) return false;
    const merged = pr.mergedAt ? new Date(pr.mergedAt).getTime() : null;
    return inWindow(openedAt(pr)) || (merged !== null && inWindow(merged));
  });
  const reviews = reviewLog().filter((review) => {
    if (!inWindow(new Date(review.submittedAt).getTime())) return false;
    if (input.projectId === null) return true;
    const repo = REPOS.find((entry) => entry.projectId === input.projectId);
    return repo ? review.repository === (repo.githubRepo ?? `adamthuvesen/${repo.name}`) : false;
  });

  const totals = totalsFrom(windowed);
  totals.prsOpened = prs.filter((pr) => inWindow(openedAt(pr))).length;
  totals.prsMerged = prs.filter((pr) => pr.state === "merged").length;
  totals.prsClosed = prs.filter((pr) => pr.state === "closed").length;
  totals.reviewsGiven = reviews.length;
  totals.reviewApprovals = reviews.filter((review) => review.state === "approved").length;
  totals.reviewChangesRequested = reviews.filter((review) => review.state === "changes_requested").length;
  totals.reviewComments = reviews.filter((review) => review.state === "commented").length;

  const previous = totalsFrom(previousWindow);
  previous.prsMerged = Math.round(totals.prsMerged * 0.83);
  previous.reviewsGiven = Math.round(totals.reviewsGiven * 0.91);

  const heatmap = heatmapFrom(log);
  const repositories: ActivityRepository[] = REPOS.map((repo) => {
    const row = perRepo.get(repo.projectId);
    return {
      projectId: repo.projectId,
      name: repo.name,
      path: repo.path,
      githubRepo: repo.githubRepo,
      commits: row?.commits ?? 0,
      linesAdded: row?.added ?? 0,
      linesRemoved: row?.removed ?? 0,
      prsMerged: pullRequestLog().filter(
        (pr) => pr.projectId === repo.projectId && pr.state === "merged" && inWindow(openedAt(pr))
      ).length,
      lastCommitAt: row?.last ? new Date(row.last).toISOString() : null,
      share: windowTotal > 0 ? (row?.commits ?? 0) / windowTotal : 0
    };
  }).sort((left, right) => right.commits - left.commits);

  return {
    ...base,
    totals,
    // A still-scanning ledger has no honest earlier window to compare with.
    previous: state === "scanning" ? null : previous,
    repositories,
    series: seriesFrom(windowed, range),
    heatmap,
    streaks: streaksFrom(heatmap, windowed),
    cadence: cadenceFrom(windowed),
    pullRequests: prs
      .sort((left, right) => openedAt(right) - openedAt(left))
      .slice(0, 100),
    reviews: reviews.slice(0, 50),
    medianCycleSeconds: median(
      prs.flatMap((pr) => (pr.cycleSeconds === null ? [] : [pr.cycleSeconds]))
    )
  };
}
