import type { JSX } from "react";

const ROW_KEYS = ["row-1", "row-2", "row-3", "row-4", "row-5"] as const;

/**
 * The pane skeleton: a panel's placeholder while its code chunk or its first
 * payload is on the way. One of the app's three loading shapes — the others are
 * `LinesSkeleton` for text and `LoadingLine` for anything smaller than a pane
 * (styles/loading.css names the rule).
 *
 * `label` is what is loading, said plainly: it is the only thing a screen
 * reader gets out of the pane, so "Loading settings" and "Loading usage" are
 * worth the prop.
 */
export function SkeletonPane({ label = "Loading" }: { label?: string }): JSX.Element {
  return (
    <div className="skeleton-pane" role="status" aria-busy="true" aria-label={label}>
      <div className="skeleton-header">
        <div className="loading-block skeleton-block-title" />
        <div className="loading-block skeleton-block-subtitle" />
      </div>
      <div className="skeleton-rows">
        {ROW_KEYS.map((key) => (
          <div className="skeleton-row" key={key}>
            <div className="loading-block skeleton-row-avatar" />
            <div className="skeleton-row-body">
              <div className="loading-block skeleton-row-line" />
              <div className="loading-block skeleton-row-line skeleton-row-line-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
