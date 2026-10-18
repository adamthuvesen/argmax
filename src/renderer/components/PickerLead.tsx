import { Check } from "lucide-react";
import type { JSX, ReactNode } from "react";

/**
 * The 16px lead cell of a picker row: the row's glyph, or a check once the row
 * is the chosen one. Every listbox picker renders it on every row (empty when a
 * row has neither), so labels sit on one column across the menu — the macOS
 * menu convention. Styled by `.picker-lead` in chat-chrome.css.
 */
export function PickerLead({
  selected = false,
  children
}: {
  selected?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span className="picker-lead" aria-hidden="true">
      {selected ? <Check size={13} strokeWidth={2.4} /> : children}
    </span>
  );
}
