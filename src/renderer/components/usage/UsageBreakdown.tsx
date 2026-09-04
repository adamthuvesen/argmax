import { useEffect, useId, useState, type JSX } from "react";
import type { UsageDayRow, UsageModelRow, UsageSummary } from "../../../shared/types.js";
import { SegmentedControl } from "../settings/settingsPrimitives.js";
import {
  formatBucketTitle,
  formatCount,
  formatMetric,
  formatPercent,
  formatTokens,
  formatUsd
} from "./usageFormat.js";
import {
  isUnpriced,
  processedTokens,
  providerLabel,
  shareOfTotal,
  type UsageMetric
} from "./usagePresentation.js";

type BreakdownMode = "model" | "day";

const MODE_OPTIONS = [
  { value: "model", label: "Model" },
  { value: "day", label: "Day" }
];

/**
 * How many model rows the table shows before it folds. A real machine reports
 * twenty-odd models a window, and the tail below the top dozen is under a
 * tenth of a percent each — noise with a row of chrome around it. Day rows
 * never fold: a window is at most thirty buckets and they read as a timeline,
 * so cutting it at twelve would hide the half of it the user came for.
 */
const MAX_MODEL_ROWS = 12;

/** One row of the table, whichever axis it was sliced on. */
interface BreakdownRow {
  key: string;
  name: JSX.Element;
  /** What the name column sorts on: a model id, or a day's start instant. */
  sortName: string;
  /** Set on model rows; day rows aggregate every provider, so they have none. */
  provider?: UsageModelRow["provider"];
  sessions: number;
  costUsd: number;
  tokens: number;
  unpriced: boolean;
}

/** The columns, in the order they are drawn. */
type SortColumn = "name" | "sessions" | "primary" | "share" | "secondary";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

/**
 * Model rows rank by the metric the page is showing; day rows are a timeline
 * and read oldest first, which is the order the backend hands them over in.
 */
function defaultSort(mode: BreakdownMode): SortState {
  return mode === "model"
    ? { column: "primary", direction: "desc" }
    : { column: "name", direction: "asc" };
}

/** The column a figure in dollars lands in, whichever metric is active. */
function isCostColumn(column: SortColumn, metric: UsageMetric): boolean {
  return metric === "cost" ? column === "primary" || column === "share" : column === "secondary";
}

/**
 * Share is the metric over one denominator shared by every row, so it ranks
 * exactly like the metric itself — no separate comparator earns its keep.
 */
function columnValue(row: BreakdownRow, column: SortColumn, metric: UsageMetric): number {
  if (column === "sessions") return row.sessions;
  if (column === "secondary") return metric === "cost" ? row.tokens : row.costUsd;
  return metric === "cost" ? row.costUsd : row.tokens;
}

function compareName(a: BreakdownRow, b: BreakdownRow): number {
  return a.sortName.localeCompare(b.sortName, "en") || a.key.localeCompare(b.key, "en");
}

function sortRows(
  rows: readonly BreakdownRow[],
  sort: SortState,
  metric: UsageMetric
): BreakdownRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const parkUnpriced = isCostColumn(sort.column, metric);
  return [...rows].sort((a, b) => {
    // An unpriced row has no dollar figure at all, so on a cost sort it sits
    // after every row that does — in both directions, never ranked as a $0.
    if (parkUnpriced && a.unpriced !== b.unpriced) return a.unpriced ? 1 : -1;
    if (sort.column === "name") return direction * compareName(a, b);
    const delta = columnValue(a, sort.column, metric) - columnValue(b, sort.column, metric);
    if (delta !== 0) return direction * delta;
    // Ties break the same way whichever direction the column runs, so the
    // order below the sorted column never flips under the reader.
    const byMetric = columnValue(b, "primary", metric) - columnValue(a, "primary", metric);
    if (byMetric !== 0) return byMetric;
    const byOther = columnValue(b, "secondary", metric) - columnValue(a, "secondary", metric);
    return byOther !== 0 ? byOther : compareName(a, b);
  });
}

function ariaSort(column: SortColumn, sort: SortState): "ascending" | "descending" | "none" {
  if (sort.column !== column) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

function nounFor(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${nounFor(count, noun)}`;
}

function modelRows(models: readonly UsageModelRow[]): BreakdownRow[] {
  return models.map((row) => ({
    key: `${row.provider}:${row.modelId}`,
    provider: row.provider,
    sortName: row.modelId,
    name: (
      <span className="usage-table-model usage-series" data-provider={row.provider}>
        <span className="usage-series-dot" aria-hidden="true" />
        <span className="usage-table-model-id">{row.modelId}</span>
        <span className="usage-table-model-provider">{providerLabel(row.provider)}</span>
      </span>
    ),
    sessions: row.sessions,
    costUsd: row.costUsd,
    tokens: processedTokens(row.tokens),
    unpriced: isUnpriced(row.costSource)
  }));
}

function dayRows(days: readonly UsageDayRow[], summary: UsageSummary): BreakdownRow[] {
  return days.map((row) => ({
    key: row.bucketStart,
    // RFC 3339 in UTC, so a lexical sort of the key is a chronological one.
    sortName: row.bucketStart,
    name: (
      <span className="usage-table-day">
        {formatBucketTitle(row.bucketStart, "day", summary.timeZone)}
      </span>
    ),
    sessions: row.sessions,
    costUsd: row.costUsd,
    tokens: processedTokens(row.tokens),
    unpriced: isUnpriced(row.costSource)
  }));
}

function SortHeader({
  column,
  label,
  numeric,
  sort,
  onSort
}: {
  column: SortColumn;
  label: string;
  numeric?: boolean;
  sort: SortState;
  onSort: (column: SortColumn) => void;
}): JSX.Element {
  const active = sort.column === column;
  return (
    <th
      scope="col"
      className={numeric ? "usage-table-num" : undefined}
      aria-sort={ariaSort(column, sort)}
    >
      <button
        type="button"
        className="usage-sort"
        aria-label={`Sort by ${label}`}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        {/* The glyph, not its colour, is what marks the sorted column; it
            keeps its box when inactive so the labels never shift. */}
        <span className="usage-sort-caret" data-active={active ? "true" : "false"} aria-hidden="true">
          {active && sort.direction === "asc" ? "↑" : "↓"}
        </span>
      </button>
    </th>
  );
}

export function UsageBreakdown({
  summary,
  metric
}: {
  summary: UsageSummary;
  metric: UsageMetric;
}): JSX.Element {
  const [mode, setMode] = useState<BreakdownMode>("model");
  const [sort, setSort] = useState<SortState>(() => defaultSort("model"));
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();

  // A sort pinned to "Cost" means nothing once the page is showing tokens, and
  // the two modes rank different things, so either change goes back to default.
  useEffect(() => {
    setSort(defaultSort(mode));
  }, [metric, mode]);

  // Only Model mode folds, so an expansion carried across the switch is stale.
  useEffect(() => {
    setExpanded(false);
  }, [mode]);

  const rows = mode === "model" ? modelRows(summary.models) : dayRows(summary.days, summary);
  const sorted = sortRows(rows, sort, metric);

  // An unpriced row counts no dollars, so it must not sit in the cost
  // denominator either — otherwise every priced row's share is understated by
  // whatever the unknown model spent. Both totals cover every row, so neither
  // sorting nor folding the tail can move a share.
  const costTotal = sorted.reduce((sum, row) => (row.unpriced ? sum : sum + row.costUsd), 0);
  const tokenTotal = sorted.reduce((sum, row) => sum + row.tokens, 0);
  const shareTotal = metric === "cost" ? costTotal : tokenTotal;
  const primaryLabel = metric === "cost" ? "Cost" : "Tokens";
  const secondaryLabel = metric === "cost" ? "Tokens" : "Cost";
  const noun = mode === "model" ? "model" : "day";

  const folds = mode === "model" && sorted.length > MAX_MODEL_ROWS;
  const visible = folds && !expanded ? sorted.slice(0, MAX_MODEL_ROWS) : sorted;
  const hidden = folds && !expanded ? sorted.slice(MAX_MODEL_ROWS) : [];
  const hiddenSessions = hidden.reduce((sum, row) => sum + row.sessions, 0);
  const hiddenTokens = hidden.reduce((sum, row) => sum + row.tokens, 0);
  const hiddenCost = hidden.reduce((sum, row) => (row.unpriced ? sum : sum + row.costUsd), 0);
  const hiddenPrimary = metric === "cost" ? hiddenCost : hiddenTokens;
  const countLabel =
    visible.length === sorted.length
      ? plural(sorted.length, noun)
      : `Top ${formatCount(visible.length)} of ${plural(sorted.length, noun)}`;

  const onSort = (column: SortColumn): void => {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "name" ? "asc" : "desc" }
    );
  };

  return (
    <section className="usage-section" aria-labelledby={headingId}>
      <div className="usage-section-head">
        <h2 className="usage-section-title" id={headingId}>
          Breakdown
        </h2>
        {sorted.length > 0 ? <span className="usage-table-count">{countLabel}</span> : null}
        <SegmentedControl
          ariaLabel="Break usage down by"
          name="usage-breakdown-mode"
          value={mode}
          onChange={(next) => setMode(next as BreakdownMode)}
          options={MODE_OPTIONS}
        />
      </div>
      {sorted.length === 0 ? (
        <p className="usage-empty-note">Nothing recorded in this window yet.</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table" aria-label={mode === "model" ? "Usage by model" : "Usage by day"}>
            <thead>
              <tr>
                <SortHeader
                  column="name"
                  label={mode === "model" ? "Model" : "Day"}
                  sort={sort}
                  onSort={onSort}
                />
                <SortHeader column="sessions" label="Sessions" numeric sort={sort} onSort={onSort} />
                <SortHeader column="primary" label={primaryLabel} numeric sort={sort} onSort={onSort} />
                <SortHeader column="share" label="Share" numeric sort={sort} onSort={onSort} />
                <SortHeader
                  column="secondary"
                  label={secondaryLabel}
                  numeric
                  sort={sort}
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const primary = metric === "cost" ? row.costUsd : row.tokens;
                const secondary = metric === "cost" ? row.tokens : row.costUsd;
                const excluded = metric === "cost" && row.unpriced;
                const share = excluded ? null : shareOfTotal(primary, shareTotal);
                return (
                  <tr key={row.key} className="usage-series" data-provider={row.provider}>
                    <th scope="row">{row.name}</th>
                    <td className="usage-table-num">{formatCount(row.sessions)}</td>
                    <td className="usage-table-num">
                      {excluded ? (
                        <span className="usage-badge" data-tone="unpriced">
                          Unpriced
                        </span>
                      ) : (
                        formatMetric(primary, metric)
                      )}
                    </td>
                    <td className="usage-table-num">
                      <span className="usage-share">
                        <span className="usage-share-value">{formatPercent(share)}</span>
                        <ShareMeter share={share} />
                      </span>
                    </td>
                    <td className="usage-table-num">
                      {metric === "cost"
                        ? formatTokens(secondary)
                        : row.unpriced
                          ? "—"
                          : formatUsd(secondary)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {folds ? (
              <tfoot>
                {hidden.length > 0 ? (
                  <tr>
                    <th scope="row">
                      +{formatCount(hidden.length)} more {nounFor(hidden.length, noun)}
                    </th>
                    <td className="usage-table-num">{formatCount(hiddenSessions)}</td>
                    <td className="usage-table-num">{formatMetric(hiddenPrimary, metric)}</td>
                    <td className="usage-table-num">
                      {formatPercent(shareOfTotal(hiddenPrimary, shareTotal))}
                    </td>
                    <td className="usage-table-num">
                      {metric === "cost" ? formatTokens(hiddenTokens) : formatUsd(hiddenCost)}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={5}>
                    <button
                      type="button"
                      className="usage-table-toggle"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((open) => !open)}
                    >
                      {expanded ? "Show fewer" : `Show all ${plural(sorted.length, noun)}`}
                    </button>
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The share meter. Its length is data, so it stays an SVG attribute rather
 * than an inline width, and the viewBox is drawn in the pixels it occupies so
 * the cap radius is not stretched sideways. The track is a hairline rule, not
 * a filled box: a row under a tenth of a percent should read as nearly
 * nothing rather than as an empty container.
 */
function ShareMeter({ share }: { share: number | null }): JSX.Element {
  const width = share === null ? 0 : Math.max(2, Math.round(share * 96));
  return (
    <svg
      className="usage-share-meter"
      viewBox="0 0 96 8"
      width="96"
      height="8"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="usage-share-track" x="0" y="3" width="96" height="2" rx="1" />
      <rect className="usage-share-fill" x="0" y="1" width={width} height="6" rx="3" />
    </svg>
  );
}
