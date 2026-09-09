import type { JSX } from "react";
import { WorkingNest } from "./WorkingNest.js";

/**
 * The loading line: the working nest and one phrase, in the place the content
 * will appear. The third of the app's loading shapes (styles/loading.css), and
 * the one for everything too small to be worth a skeleton — a settings group,
 * a popover, a list that has not come back yet.
 *
 * It exists so no surface has to fall back on a bare "Loading…" string. The
 * mark is what says *wait*; without it the phrase reads as content, and five
 * such strings had drifted into five different sizes and colours.
 */
export function LoadingLine({
  label,
  className
}: {
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <p
      className={`loading-line${className ? ` ${className}` : ""}`}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <WorkingNest active size={13} />
      <span>{label}</span>
    </p>
  );
}
