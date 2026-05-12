import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { KEYBOARD_BINDINGS } from "../lib/keyboardBindings.js";

export function KeyboardCheatSheet({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="cheat-sheet-overlay"
      role="dialog"
      aria-label="Keyboard shortcuts"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="cheat-sheet">
        <header className="cheat-sheet-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
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
