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
 * A share as a bar width in the bar's own 0–100 viewBox. A provider that
 * spent something keeps a visible sliver rather than rounding away to
 * nothing — the same floor the breakdown table's share meter uses.
 */
function barWidth(share: number | null): number {
  if (share === null || share <= 0) return 0;
  return Math.min(100, Math.max(0.8, share * 100));
}

/**
 * One row per provider, and the page's filter: pressing a row narrows the
 * hero, chart, totals, and breakdown to that provider; pressing it again
 * widens back out. The rows themselves never narrow — their shares stay
 * shares of the whole window, which is what makes the comparison useful
 * while one provider is in focus.
 *
 * Rank is drawn as well as written: each row is backed by a bar as long as
 * its share, in the provider's own series colour, so the order reads before
 * a single figure is.
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

  return (
    <ul className="usage-provider-rows" aria-label="Usage by provider" data-narrowed={selected ? "true" : "false"}>
      {rows.map((row) => {
        const value = providerValue(row, metric);
        const share = row.available ? shareOfTotal(value, total) : null;
        const pressed = selected === row.provider;
        const body = (
          <>
            {/* Rank is drawn as a rule along the row's base rather than as a
                wash behind it: a tinted block ending on a hard vertical reads
                as a *selected* row, and for Codex — whose series colour is the
                neutral ink — it painted the exact grey the pressed state uses.
                A rule can only mean one thing. The length is data, so it is an
                SVG attribute rather than an inline width; everything else is
                CSS. Decorative: the percentage is in the text beside it. */}
            {row.available ? (
              <svg
                className="usage-provider-bar"
                viewBox="0 0 100 3"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <rect className="usage-provider-bar-track" x="0" y="1" width="100" height="1" />
                <rect className="usage-provider-bar-fill" x="0" y="0" width={barWidth(share)} height="3" />
              </svg>
            ) : null}
            <span className="usage-provider-body">
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
                    {formatPercent(share)}
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
