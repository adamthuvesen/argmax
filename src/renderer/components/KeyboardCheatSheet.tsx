import { useEffect, useRef, type JSX } from "react";
import { KEYBOARD_BINDINGS } from "../lib/keyboardBindings.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

export function KeyboardCheatSheet({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Document-level Esc + outside-click. Listening at the document means Esc
  // fires regardless of where focus lives — previously the dialog held a
  // local `onKeyDown` that never ran when the cheat sheet was opened via the
  // native menu while the composer textarea kept focus (the useOverlays Esc
  // handler skips typing targets by design).
  useDismissOnOutsideOrEscape(dialogRef, open, onClose);

  // Focus the close button on open so keyboard users land somewhere inside
  // the dialog, and restore focus to the trigger on close.
  useEffect(() => {
    if (!open) {
      const previous = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
      return;
    }
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="cheat-sheet-overlay"
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      <div className="cheat-sheet" ref={dialogRef}>
        <header className="cheat-sheet-header">
          <h2>Keyboard shortcuts</h2>
          <button ref={closeButtonRef} type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <dl className="cheat-sheet-list">
          {KEYBOARD_BINDINGS.map((binding) => (
            <div className="cheat-sheet-row" key={binding.accelerator}>
              <dt>
                <kbd>{binding.accelerator}</kbd>
              </dt>
              <dd>{binding.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
