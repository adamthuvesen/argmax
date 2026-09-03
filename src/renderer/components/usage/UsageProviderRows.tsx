import type { JSX } from "react";
import type { ProviderId, UsageSummary } from "../../../shared/types.js";
import { formatCount, formatMetric, formatPercent, formatTokens, formatUsd } from "./usageFormat.js";
import {
  orderedProviderRows,
  processedTokens,
  providerLabel,
  providerValue,
  shareOfTotal,
  type UsageMetric
} from "./usagePresentation.js";

/**
 * One row per provider, and the page's filter: pressing a row narrows the
 * hero, chart, totals, and breakdown to that provider; pressing it again
 * widens back out. The rows themselves never narrow — their shares stay
 * shares of the whole window, which is what makes the comparison useful
 * while one provider is in focus.
 */
export function UsageProviderRows({
  summary,
  metric,
  selected,
  onSelect
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  selected: ProviderId | null;
  onSelect: (provider: ProviderId | null) => void;
}): JSX.Element {
  const rows = orderedProviderRows(summary.providers, metric);
  // Shares are taken against the sum of the rows on screen rather than the
  // window total, so a page where one provider is unpriced still adds to 100%
  // of what is actually shown.
  const total = rows.reduce((sum, row) => sum + providerValue(row, metric), 0);
  const metricWord = metric === "cost" ? "cost" : "tokens";

  return (
    <ul className="usage-provider-rows" aria-label="Usage by provider" data-narrowed={selected ? "true" : "false"}>
      {rows.map((row) => {
        const value = providerValue(row, metric);
        const share = row.available ? shareOfTotal(value, total) : null;
        const pressed = selected === row.provider;
        const body = (
          <>
            <span className="usage-series-dot" aria-hidden="true" />
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
          </>
        );
        return (
          <li
            key={row.provider}
            className="usage-provider-row usage-series"
            data-provider={row.provider}
            data-available={row.available ? "true" : "false"}
            data-selected={pressed ? "true" : "false"}
          >
            {row.available ? (
              <button
                type="button"
                className="usage-provider-toggle"
                aria-pressed={pressed}
                title={pressed ? "Show every provider" : `Show only ${providerLabel(row.provider)}`}
                onClick={() => onSelect(pressed ? null : row.provider)}
              >
                {body}
              </button>
            ) : (
              <span className="usage-provider-toggle">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
