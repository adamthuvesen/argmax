import { useId, type JSX } from "react";
import type { UsageSummary, UsageTokenTotals } from "../../../shared/types.js";
import { formatPercent, formatTokens, formatUsd } from "./usageFormat.js";
import { processedTokens, shareOfTotal } from "./usagePresentation.js";

/**
 * Where the tokens went. Processed tokens are one whole, not five peers:
 * cache read, cache written, uncached input, and output are the four parts a
 * request spends, and they are drawn as one stacked bar at their true shares.
 * Reasoning lives *inside* output, so it is a note on that segment rather
 * than a fifth one that would double-count the bar.
 */

/** The four parts of a processed token, in the order a request spends them. */
type FlowPart = "cache-read" | "cache-write" | "uncached" | "output";

interface FlowSegment {
  part: FlowPart;
  label: string;
  tokens: number;
  /** A fact that belongs to this part alone, not to a tile of its own. */
  note: string | null;
}

/** The bar's user space. The SVG scales it to whatever the card gives it. */
const SPAN = 100;
/** The hairline between two segments, in the same user-space units. */
const GAP = 0.25;
/** Width a non-zero segment never draws under, so 0.3% of the whole still reads. */
const MIN_DRAWN = 0.6;

interface DrawnSegment extends FlowSegment {
  x: number;
  width: number;
}

function flowSegments(tokens: UsageTokenTotals): FlowSegment[] {
  return [
    { part: "cache-read", label: "Cache read", tokens: tokens.cacheRead, note: null },
    { part: "cache-write", label: "Cache written", tokens: tokens.cacheWrite, note: null },
    {
      part: "uncached",
      label: "Uncached input",
      tokens: tokens.inputUncached,
      note: "at the full input rate"
    },
    {
      part: "output",
      label: "Output",
      tokens: tokens.output,
      note: `${formatTokens(tokens.reasoning)} of it reasoning`
    }
  ];
}

/** Three decimals is finer than a pixel at any card width, and keeps the DOM readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The bar's geometry. Shares are never rescaled — the skew is the finding —
 * but a segment worth a third of a percent would otherwise be sub-pixel, so
 * every non-zero part gets a floor and the widest part pays for it. The debt
 * is at most three floors and the widest part is at least a quarter of the
 * bar, so it can always cover it.
 */
function layoutSegments(segments: readonly FlowSegment[], total: number): DrawnSegment[] {
  const floor = MIN_DRAWN + GAP;
  const shares = segments.map((segment) => (segment.tokens / total) * SPAN);
  const widths = shares.map((share, index) =>
    segments[index].tokens > 0 ? Math.max(share, floor) : 0
  );
  const debt = widths.reduce((sum, width, index) => sum + width - shares[index], 0);
  const widest = shares.reduce((best, share, index) => (share > shares[best] ? index : best), 0);
  widths[widest] -= debt;

  const drawn: DrawnSegment[] = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const width = widths[index];
    if (width > 0) {
      // Every segment but the first gives its leading edge to the gap, so the
      // bar still starts at 0 and ends at SPAN.
      const inset = drawn.length === 0 ? 0 : GAP;
      drawn.push({ ...segment, x: round(cursor + inset), width: round(width - inset) });
    }
    cursor += width;
  }
  return drawn;
}

/**
 * How much of the uncached bill the cache reads took off. `costUsd` is what
 * the window actually cost and `cacheSavingsUsd` is what the reads would have
 * cost on top at the full input rate, so the two add to the counterfactual.
 */
function savingsShare(summary: UsageSummary): number | null {
  if (!(summary.cacheSavingsUsd > 0) || !(summary.costUsd > 0)) return null;
  return shareOfTotal(summary.cacheSavingsUsd, summary.cacheSavingsUsd + summary.costUsd);
}

export function UsageTokenFlow({ summary }: { summary: UsageSummary }): JSX.Element {
  const headingId = useId();
  const processed = processedTokens(summary.tokens);
  const segments = flowSegments(summary.tokens);
  const drawn = processed > 0 ? layoutSegments(segments, processed) : [];
  const saved = summary.cacheSavingsUsd;
  const savedShare = savingsShare(summary);

  return (
    <section className="usage-flow" aria-labelledby={headingId}>
      <div className="usage-flow-head">
        <h2 className="usage-flow-title" id={headingId}>
          Where the tokens went
        </h2>
        <p className="usage-flow-total">
          <span className="usage-flow-total-value">{formatTokens(processed)}</span> processed
        </p>
      </div>

      {processed <= 0 ? (
        <p className="usage-flow-empty">No tokens processed in this window yet.</p>
      ) : (
        <div className="usage-flow-body">
          <div className="usage-flow-parts">
            {/* Decorative: every figure it draws is spelled out in the legend
                below it. The lengths are data, so they are SVG attributes
                rather than inline widths. */}
            <svg
              className="usage-flow-bar"
              viewBox={`0 0 ${SPAN} 12`}
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              {drawn.map((segment) => (
                <rect
                  className="usage-flow-segment"
                  key={segment.part}
                  data-part={segment.part}
                  x={segment.x}
                  y="0"
                  width={segment.width}
                  height="12"
                />
              ))}
            </svg>

            <ul className="usage-flow-legend">
              {segments.map((segment) => (
                <li className="usage-flow-legend-item" key={segment.part} data-part={segment.part}>
                  <span className="usage-flow-swatch" aria-hidden="true" />
                  <span className="usage-flow-name">
                    <span className="usage-flow-label">{segment.label}</span>
                    {segment.note ? <span className="usage-flow-note">{segment.note}</span> : null}
                  </span>
                  <span className="usage-flow-count">{formatTokens(segment.tokens)}</span>
                  <span className="usage-flow-share">
                    {formatPercent(shareOfTotal(segment.tokens, processed))}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="usage-flow-savings" data-earned={saved > 0 ? "true" : "false"}>
            <span className="usage-flow-savings-label">Cache savings</span>
            <span className="usage-flow-savings-value">{formatUsd(saved)}</span>
            {savedShare === null ? null : (
              <span className="usage-flow-savings-note">
                {formatPercent(savedShare)} off the uncached bill
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
