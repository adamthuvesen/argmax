import type { JSX } from "react";

const TILE_KEYS = ["claude", "codex", "cursor", "opencode", "grok"] as const;
const FLOW_KEYS = ["cache-read", "cache-written", "input", "output"] as const;
const TABLE_KEYS = ["head", "row-1", "row-2", "row-3", "row-4", "row-5"] as const;

/**
 * The Usage page's own placeholder. The generic pane skeleton draws rows, and
 * this page is a dashboard: a total, a tile per provider, a full-width chart,
 * the token flow, then the table. The page waits for both of its reads before
 * it paints anything (UsagePanel), so this is on screen long enough that a
 * shape which is not the page's own would be a small lie.
 */
export function UsageSkeleton(): JSX.Element {
  return (
    <div className="usage-skeleton" role="status" aria-busy="true" aria-label="Loading usage">
      <div className="usage-skeleton-fold">
        <span className="loading-block usage-skeleton-total" />
        <div className="usage-skeleton-tiles">
          {TILE_KEYS.map((key) => (
            <span key={key} className="loading-block usage-skeleton-tile" />
          ))}
        </div>
      </div>
      <span className="loading-block usage-skeleton-chart" />
      <div className="usage-skeleton-flow">
        {FLOW_KEYS.map((key) => (
          <span key={key} className="loading-block usage-skeleton-flow-part" />
        ))}
      </div>
      <div className="usage-skeleton-table">
        {TABLE_KEYS.map((key) => (
          <span key={key} className="loading-block usage-skeleton-table-row" />
        ))}
      </div>
    </div>
  );
}
