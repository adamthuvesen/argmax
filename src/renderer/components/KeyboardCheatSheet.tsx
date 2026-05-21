import { useEffect, useRef, type JSX } from "react";
import { KEYBOARD_BINDINGS } from "../lib/keyboardBindings.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";

export function KeyboardCheatSheet({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useDismissOnOutsideOrEscape(dialogRef, open, onClose, undefined, { trapFocus: true });
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) return;
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
