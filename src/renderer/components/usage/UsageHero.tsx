import { useId, type JSX } from "react";
import type { ProviderId, UsageCostSource, UsageSummary } from "../../../shared/types.js";
import { formatCount, formatMetric, formatPricingDate } from "./usageFormat.js";
import { peakBucket, perBucketAverage, type UsageDelta } from "./usageInsights.js";
import { processedTokens, providerLabel, type UsageMetric } from "./usagePresentation.js";

/** Re-exported so a caller can type the prop without reaching past the card. */
export type { UsageDelta } from "./usageInsights.js";

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

const DELTA_GLYPH: Record<UsageDelta["direction"], string> = {
  up: "↑",
  down: "↓",
  flat: "→"
};

/** The direction for a reader who cannot see the glyph. */
const DELTA_WORD: Record<UsageDelta["direction"], string> = {
  up: "up",
  down: "down",
  flat: "level"
};

/**
 * `18%`, `2.4%`, `<0.1%`. A delta is a comparison rather than a measurement,
 * so it drops to whole percents as soon as the decimal stops carrying
 * anything.
 */
function formatDeltaRatio(ratio: number): string {
  const magnitude = Math.abs(ratio) * 100;
  if (!Number.isFinite(magnitude)) return "—";
  if (magnitude === 0) return "0%";
  if (magnitude < 0.1) return "<0.1%";
  if (magnitude >= 10) return `${Math.round(magnitude)}%`;
  return `${magnitude.toFixed(1)}%`;
}

/**
 * The window against the one before it. Deliberately neutral ink: spending
 * more this month than last is not an error state, and painting it in
 * `--rose` would be the page moralising about the user's own bill.
 */
function UsageDeltaChip({ delta }: { delta: UsageDelta }): JSX.Element {
  return (
    <span className="usage-hero-delta" data-direction={delta.direction}>
      <span className="usage-hero-delta-glyph" aria-hidden="true">
        {DELTA_GLYPH[delta.direction]}
      </span>
      <span className="usage-visually-hidden">{DELTA_WORD[delta.direction]}</span>
      {formatDeltaRatio(delta.ratio)}
      <span className="usage-hero-delta-vs">vs {delta.previousLabel}</span>
    </span>
  );
}

export function UsageHero({
  summary,
  metric,
  delta,
  onShowAll
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  /** How this window compares with the one before it; omitted is no chip. */
  delta?: UsageDelta | null;
  onShowAll: () => void;
}): JSX.Element {
  const eyebrowId = useId();
  const total = metric === "cost" ? summary.costUsd : processedTokens(summary.tokens);
  const sessions = formatCount(summary.sessions);
  const narrowed: ProviderId | null = summary.provider ?? null;
  // Either clause is dropped rather than faked when the window is too young
  // to support it, so the line can be one clause, two, or absent.
  const average = perBucketAverage(summary, metric);
  const peak = peakBucket(summary, metric);
  const insight = [
    average ? `${formatMetric(average.value, metric)} ${average.unitLabel}` : null,
    peak ? `busiest ${peak.label}, ${formatMetric(peak.value, metric)}` : null
  ].filter((clause): clause is string => clause !== null);

  return (
    <div className="usage-hero">
      {/* The eyebrow is the figure's label, so it names it rather than being
          read as a second stray line beside it. */}
      <p className="usage-hero-eyebrow" id={eyebrowId}>
        {metric === "cost" ? "Total cost" : "Total tokens"}
      </p>
      <div className="usage-hero-headline">
        <p className="usage-hero-figure" aria-labelledby={eyebrowId}>
          {formatMetric(total, metric)}
        </p>
        {delta ? <UsageDeltaChip delta={delta} /> : null}
      </div>
      <p className="usage-hero-sub">
        {narrowed ? (
          <span className="usage-hero-clause usage-hero-scope usage-series" data-provider={narrowed}>
            <span className="usage-series-dot" aria-hidden="true" />
            {providerLabel(narrowed)}
          </span>
        ) : null}
        <span className="usage-hero-clause">
          {narrowed ? (
            <span className="usage-dot-sep" aria-hidden="true">
              ·{" "}
            </span>
          ) : null}
          {sessions} {summary.sessions === 1 ? "session" : "sessions"}
        </span>
        <span className="usage-hero-clause">
          <span className="usage-dot-sep" aria-hidden="true">
            ·{" "}
          </span>
          {provenance(summary.costSource, metric)}
        </span>
        {narrowed ? (
          <button type="button" className="usage-hero-show-all" onClick={onShowAll}>
            Show all
          </button>
        ) : null}
      </p>
      {insight.length > 0 ? <p className="usage-hero-insight">{insight.join(" · ")}</p> : null}
      {/* The last line is always present, and always says the thing that
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
