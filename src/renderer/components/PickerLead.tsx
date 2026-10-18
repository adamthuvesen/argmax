import type { JSX, ReactNode } from "react";

/**
 * The 16px lead cell of a picker row: the row's glyph, or empty. Every listbox
 * picker renders it on every row, so labels sit on one column across the menu.
 * The chosen row's check is not here: `.project-picker-item` draws it at the
 * row's right edge from the row's aria state (chat-chrome.css).
 */
export function PickerLead({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <span className="picker-lead" aria-hidden="true">
      {children}
    </span>
  );
}
