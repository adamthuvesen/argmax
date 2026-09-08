/**
 * What a picker row is called: its `aria-label` when it carries one (a row that
 * shows a shortened label names itself with the full one), else its visible
 * text minus the `aria-hidden` trailing column. Tests that assert row order
 * read this rather than `textContent`, which would glue "200K" onto "Haiku 4.5".
 */
export function optionName(option: HTMLElement): string {
  const label = option.getAttribute("aria-label");
  if (label) return label;
  const clone = option.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return clone.textContent?.trim() ?? "";
}
