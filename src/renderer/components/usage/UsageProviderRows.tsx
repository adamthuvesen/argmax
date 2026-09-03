import type { JSX } from "react";
import type { UsageSummary } from "../../../shared/types.js";
import { ProviderGlyph } from "./ProviderGlyph.js";
import { formatCount, formatMetric, formatPercent, formatTokens, formatUsd } from "./usageFormat.js";
import {
  orderedProviderRows,
  processedTokens,
  providerLabel,
  providerValue,
  shareOfTotal,
  type UsageMetric
} from "./usagePresentation.js";

export function UsageProviderRows({
  summary,
  metric
}: {
  summary: UsageSummary;
  metric: UsageMetric;
}): JSX.Element {
  const rows = orderedProviderRows(summary.providers, metric);
  // Shares are taken against the sum of the rows on screen rather than the
  // window total, so a page where one provider is unpriced still adds to 100%
  // of what is actually shown.
  const total = rows.reduce((sum, row) => sum + providerValue(row, metric), 0);
  const metricWord = metric === "cost" ? "cost" : "tokens";

  return (
    <ul className="usage-provider-rows" aria-label="Usage by provider">
      {rows.map((row) => {
        const value = providerValue(row, metric);
        const share = row.available ? shareOfTotal(value, total) : null;
        return (
          <li
            key={row.provider}
            className="usage-provider-row usage-series"
            data-provider={row.provider}
            data-available={row.available ? "true" : "false"}
          >
            <span className="usage-series-dot" aria-hidden="true" />
            <span className="usage-provider-mark" aria-hidden="true">
              <ProviderGlyph provider={row.provider} />
            </span>
            <span className="usage-provider-text">
              <span className="usage-provider-name">{providerLabel(row.provider)}</span>
              <span className="usage-provider-sessions">
                {row.available
                  ? `${formatCount(row.sessions)} ${row.sessions === 1 ? "session" : "sessions"}`
                  : "No local usage data"}
              </span>
            </span>
            <span className="usage-provider-figures">
              <span className="usage-provider-amount">
                {row.available ? formatMetric(value, metric) : "—"}
              </span>
              {row.available ? (
                <span className="usage-provider-detail">
                  {formatPercent(share)} of {metricWord}
                  <span className="usage-dot-sep" aria-hidden="true">
                    ·
                  </span>
                  {/* The figure the headline is not already showing, so a row
                      never spends its second line repeating its first. */}
                  {metric === "cost"
                    ? `${formatTokens(processedTokens(row.tokens))} tokens`
                    : formatUsd(row.costUsd)}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
