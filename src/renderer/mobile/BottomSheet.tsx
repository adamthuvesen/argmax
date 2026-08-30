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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="mobile-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mobile-sheet"
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

/** A sheet row. `selected` marks the current value in a picker; leave it false
 *  for an action row, which shows no checkmark. */
export function SheetOption({
  label,
  selected = false,
  danger = false,
  onSelect
}: {
  label: string;
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
      <span>{label}</span>
      {selected ? <Check size={16} aria-hidden="true" /> : null}
    </button>
  );
}
