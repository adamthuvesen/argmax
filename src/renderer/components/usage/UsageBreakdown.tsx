import { useId, useState, type JSX } from "react";
import type { UsageDayRow, UsageModelRow, UsageSummary } from "../../../shared/types.js";
import { SegmentedControl } from "../settings/settingsPrimitives.js";
import { ProviderGlyph } from "./ProviderGlyph.js";
import {
  formatBucketTitle,
  formatCount,
  formatMetric,
  formatPercent,
  formatTokens,
  formatUsd
} from "./usageFormat.js";
import { isUnpriced, processedTokens, providerLabel, type UsageMetric } from "./usagePresentation.js";

type BreakdownMode = "model" | "day";

const MODE_OPTIONS = [
  { value: "model", label: "Model" },
  { value: "day", label: "Day" }
];

/** One row of the table, whichever axis it was sliced on. */
interface BreakdownRow {
  key: string;
  name: JSX.Element;
  /** Set on model rows; day rows aggregate every provider, so they have none. */
  provider?: UsageModelRow["provider"];
  sessions: number;
  costUsd: number;
  tokens: number;
  unpriced: boolean;
}

function modelRows(models: readonly UsageModelRow[]): BreakdownRow[] {
  return models.map((row) => ({
    key: `${row.provider}:${row.modelId}`,
    provider: row.provider,
    name: (
      <span className="usage-table-model usage-series" data-provider={row.provider}>
        <span className="usage-provider-mark" aria-hidden="true">
          <ProviderGlyph provider={row.provider} />
        </span>
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

export function UsageBreakdown({
  summary,
  metric
}: {
  summary: UsageSummary;
  metric: UsageMetric;
}): JSX.Element {
  const [mode, setMode] = useState<BreakdownMode>("model");
  const headingId = useId();
  const rows = mode === "model" ? modelRows(summary.models) : dayRows(summary.days, summary);
  const sorted =
    mode === "model"
      ? [...rows].sort((a, b) =>
          metric === "cost" ? b.costUsd - a.costUsd || b.tokens - a.tokens : b.tokens - a.tokens
        )
      : rows;

  // An unpriced row counts no dollars, so it must not sit in the cost
  // denominator either — otherwise every priced row's share is understated by
  // whatever the unknown model spent.
  const costTotal = sorted.reduce((sum, row) => (row.unpriced ? sum : sum + row.costUsd), 0);
  const tokenTotal = sorted.reduce((sum, row) => sum + row.tokens, 0);
  const shareTotal = metric === "cost" ? costTotal : tokenTotal;
  const primaryLabel = metric === "cost" ? "Cost" : "Tokens";
  const secondaryLabel = metric === "cost" ? "Tokens" : "Cost";

  return (
    <section className="usage-section" aria-labelledby={headingId}>
      <div className="usage-section-head">
        <h2 className="usage-section-title" id={headingId}>
          Breakdown
        </h2>
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
                <th scope="col">{mode === "model" ? "Model" : "Day"}</th>
                <th scope="col" className="usage-table-num">
                  Sessions
                </th>
                <th scope="col" className="usage-table-num">
                  {primaryLabel}
                </th>
                <th scope="col" className="usage-table-num">
                  Share
                </th>
                <th scope="col" className="usage-table-num">
                  {secondaryLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const primary = metric === "cost" ? row.costUsd : row.tokens;
                const secondary = metric === "cost" ? row.tokens : row.costUsd;
                const excluded = metric === "cost" && row.unpriced;
                const share = excluded || shareTotal <= 0 ? null : primary / shareTotal;
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
                        {/* The meter's length is data, so it is an SVG
                            attribute rather than an inline width. */}
                        <svg
                          className="usage-share-meter"
                          viewBox="0 0 100 4"
                          width="56"
                          height="4"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <rect className="usage-share-track" x="0" y="0" width="100" height="4" rx="2" />
                          <rect
                            className="usage-share-fill"
                            x="0"
                            y="0"
                            width={share === null ? 0 : Math.max(1, Math.round(share * 100))}
                            height="4"
                            rx="2"
                          />
                        </svg>
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
          </table>
        </div>
      )}
    </section>
  );
}
