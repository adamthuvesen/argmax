import { Search } from "lucide-react";
import type { JSX } from "react";

/**
 * The query echo for a type-to-filter popover (see `useTypeToFilter`). Renders
 * nothing until the user types, so a picker carries no search chrome at rest.
 * then shows what was typed and how much of the list survived it, which is the
 * difference between "filtering" and "the list mysteriously shrank".
 *
 * An `<li>` because every picker it sits in is a `<ul role="listbox">`.
 */
export function PickerFilterRow({
  query,
  matchCount,
  totalCount
}: {
  query: string;
  matchCount: number;
  totalCount: number;
}): JSX.Element | null {
  if (!query) return null;
  return (
    <li className="picker-filter" role="presentation">
      <Search size={11} aria-hidden="true" />
      <span className="picker-filter-query">{query}</span>
      <span className="picker-filter-count">
        {matchCount} of {totalCount}
      </span>
    </li>
  );
}
