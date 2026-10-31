import type { JSX } from "react";
import { remainingBarWidth } from "./usageFormat.js";

/**
 * The meter under a limit window's label. An SVG rather than a div so the
 * fill scales with the row's width without a layout read; the Usage card and
 * the sidebar menu draw the same bar at different sizes.
 */
export function RemainingBar({ remaining }: { remaining: number }): JSX.Element {
  return (
    <svg
      className="usage-remaining-bar"
      viewBox="0 0 100 3"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="usage-remaining-bar-track" x="0" y="1" width="100" height="1" />
      <rect
        className="usage-remaining-bar-fill"
        x="0"
        y="0"
        width={remainingBarWidth(remaining)}
        height="3"
      />
    </svg>
  );
}
