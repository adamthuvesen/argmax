import type { JSX } from "react";
import { WorkingNest } from "./WorkingNest.js";

/**
 * The loading line: the working nest alone, in the place the content will
 * appear. The third of the app's loading shapes (styles/loading.css), and the
 * one for everything too small to be worth a skeleton — a settings group, a
 * popover, a list that has not come back yet.
 *
 * The mark is what says *wait*, so it carries no visible phrase; `label` names
 * the wait for assistive tech only.
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
    </p>
  );
}
