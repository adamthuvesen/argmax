import type { JSX } from "react";
import type { UsageCostSource, UsageSummary } from "../../../shared/types.js";
import { formatCount, formatMetric, formatPricingDate } from "./usageFormat.js";
import { processedTokens, type UsageMetric } from "./usagePresentation.js";

/** Where the headline number comes from, said plainly under it. */
function provenance(costSource: UsageCostSource, metric: UsageMetric): string {
  if (metric === "tokens") return "processed tokens";
  switch (costSource) {
    case "provider_reported":
      return "reported by the provider CLIs";
    case "unpriced":
      return "no list price for these models";
    case "mixed":
      return "part reported, part list price";
    default:
      return "API estimate at list price";
  }
}

export function UsageHero({
  summary,
  metric
}: {
  summary: UsageSummary;
  metric: UsageMetric;
}): JSX.Element {
  const total = metric === "cost" ? summary.costUsd : processedTokens(summary.tokens);
  const sessions = formatCount(summary.sessions);
  return (
    <div className="usage-hero">
      <p className="usage-hero-figure" aria-label={`Total ${metric === "cost" ? "cost" : "tokens"}`}>
        {formatMetric(total, metric)}
      </p>
      <p className="usage-hero-sub">
        <span className="usage-hero-clause">
          {sessions} {summary.sessions === 1 ? "session" : "sessions"}
        </span>
        <span className="usage-hero-clause">
          <span className="usage-dot-sep" aria-hidden="true">
            ·{" "}
          </span>
          {provenance(summary.costSource, metric)}
        </span>
      </p>
      {/* The third line is always present, and always says the thing that
          qualifies the figure above it. Dropping it in one metric made the
          whole page jump when the toggle moved. */}
      <p className="usage-hero-note">
        {metric === "cost"
          ? `Prices as of ${formatPricingDate(summary.scan.pricingAsOf, summary.timeZone)}.`
          : "Reasoning is counted inside output, not added to it."}
      </p>
    </div>
  );
}
