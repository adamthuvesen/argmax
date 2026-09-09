import type { JSX } from "react";

/**
 * The lines skeleton: placeholder rows for text or code on its way in — a
 * diff, a file preview. One of the app's three loading shapes (see
 * styles/loading.css); the view opens instantly and the brief fetch reads as
 * intentional rather than as a text flash. Row widths vary via `:nth-child`
 * rules so the block reads as prose, not as a solid bar.
 */
export function LinesSkeleton({
  rows = 12,
  label,
  className
}: {
  rows?: number;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`lines-skeleton${className ? ` ${className}` : ""}`}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="loading-block lines-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
