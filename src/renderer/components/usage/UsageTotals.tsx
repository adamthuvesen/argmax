import type { JSX } from "react";
import type { UsageSummary } from "../../../shared/types.js";
import { formatTokens, formatUsd } from "./usageFormat.js";
import { processedTokens } from "./usagePresentation.js";

/**
 * The five tiles under the chart. Processed tokens is the sum of the four
 * token fields; cached and uncached input are the two halves of the input
 * side; output carries reasoning inside it, so reasoning is a note on that
 * tile rather than a sixth tile that would double-count.
 */
export function UsageTotals({ summary }: { summary: UsageSummary }): JSX.Element {
  const { tokens } = summary;
  const cachedInput = tokens.cacheRead + tokens.cacheWrite;
  const tiles: ReadonlyArray<{ label: string; value: string; note: string }> = [
    {
      label: "Processed tokens",
      value: formatTokens(processedTokens(tokens)),
      note: "input, cache, and output"
    },
    {
      label: "Cached input",
      value: formatTokens(cachedInput),
      note: `${formatTokens(tokens.cacheRead)} read · ${formatTokens(tokens.cacheWrite)} written`
    },
    {
      label: "Uncached input",
      value: formatTokens(tokens.inputUncached),
      note: "at the full input rate"
    },
    {
      label: "Output",
      value: formatTokens(tokens.output),
      note: `${formatTokens(tokens.reasoning)} of it reasoning`
    },
    {
      label: "Cache savings",
      value: formatUsd(summary.cacheSavingsUsd),
      note: "vs the uncached rate"
    }
  ];

  return (
    <ul className="usage-tiles">
      {tiles.map((tile) => (
        <li className="usage-tile" key={tile.label}>
          <span className="usage-tile-label">{tile.label}</span>
          <span className="usage-tile-value">{tile.value}</span>
          <span className="usage-tile-note">{tile.note}</span>
        </li>
      ))}
    </ul>
  );
}
