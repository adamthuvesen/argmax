import type { JSX } from "react";

/**
 * Shimmering placeholder rows shown while a content view (diff, file preview)
 * loads, in place of a bare "Loading…" line. The view opens instantly; the
 * skeleton makes the brief fetch read as intentional rather than a text flash.
 * Row widths vary via `:nth-child` rules in CSS so the block reads as text, not
 * a solid bar.
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
        <span key={index} className="lines-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
