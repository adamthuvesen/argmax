import type { JSX } from "react";

const ROW_KEYS = ["row-1", "row-2", "row-3", "row-4", "row-5"] as const;

export function SkeletonPane(): JSX.Element {
  return (
    <div
      className="skeleton-pane"
      role="status"
      aria-busy="true"
      aria-label="Loading workspace"
    >
      <div className="skeleton-header">
        <div className="skeleton-block skeleton-shimmer skeleton-block-title" />
        <div className="skeleton-block skeleton-shimmer skeleton-block-subtitle" />
      </div>
      <div className="skeleton-rows">
        {ROW_KEYS.map((key) => (
          <div className="skeleton-row" key={key}>
            <div className="skeleton-block skeleton-shimmer skeleton-row-avatar" />
            <div className="skeleton-row-body">
              <div className="skeleton-block skeleton-shimmer skeleton-row-line" />
              <div className="skeleton-block skeleton-shimmer skeleton-row-line skeleton-row-line-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
