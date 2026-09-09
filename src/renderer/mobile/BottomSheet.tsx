import { Check } from "lucide-react";
import { useEffect, type JSX, type ReactNode } from "react";

/** Bottom sheet chrome shared by every phone picker: dimmed backdrop, rounded
 *  panel, grabber. Tapping the backdrop closes it, and so does Escape — a
 *  phone paired to a keyboard, or the desktop browser the page also serves,
 *  would otherwise have the backdrop as its only way out.
 *
 *  Sheets, not native `<select>`s: iOS anchors a select's menu to its row, so
 *  a long list opened from near the bottom edge clips off-screen. */
export function BottomSheet({
  label,
  onClose,
  children
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  // A sheet is anchored to the bottom edge, so a keyboard still up from the
  // screen behind it covers the options. iOS does not move focus when a button
  // is tapped, so the composer keeps it — and the keyboard — unless the sheet
  // takes it away.
  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // `data-type-scale="chrome"` below: a sheet is chrome, not the screen that
  // opened it. Without it the sheet inherits the chat's larger scale and its
  // rows come out a third bigger than the same picker opened from the list.
  return (
    <div className="mobile-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mobile-sheet"
        data-type-scale="chrome"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-sheet-grabber" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/** A sheet row, built like the desktop picker's ledger rows: the check leads a
 *  reserved gutter so every label starts on the same edge, and `detail` carries
 *  the qualifier — a branch, a path — on its own muted line. Folding that
 *  qualifier into `label` instead is what wrapped these rows to three lines.
 *
 *  `selected` marks the current value in a picker; leave it false for an action
 *  row, which shows no checkmark. */
export function SheetOption({
  label,
  detail,
  selected = false,
  danger = false,
  onSelect
}: {
  label: string;
  detail?: string;
  selected?: boolean;
  danger?: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="mobile-sheet-option"
      data-danger={danger || undefined}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="mobile-sheet-option-check">
        {selected ? <Check size={16} aria-hidden="true" /> : null}
      </span>
      <span className="mobile-sheet-option-text">
        <span className="mobile-sheet-option-label">{label}</span>
        {detail ? <span className="mobile-sheet-option-detail">{detail}</span> : null}
      </span>
    </button>
  );
}
