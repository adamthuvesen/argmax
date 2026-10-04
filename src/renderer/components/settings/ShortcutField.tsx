import { useEffect, useRef, useState, type JSX } from "react";
import { chordFromEvent, formatChord } from "../../lib/shortcutChord.js";

/**
 * A shortcut the user records by pressing it. The button shows the chord;
 * activating it listens for the next one. Escape cancels, and a chord that is
 * not valid (no ⌘/Ctrl/⌥, or a key text entry needs) says why and keeps
 * listening. A second button restores the default, shown only when it differs.
 */
export function ShortcutField({
  ariaLabel,
  value,
  defaultValue,
  validate,
  onChange
}: {
  ariaLabel: string;
  value: string;
  defaultValue: string;
  /** A reason this chord cannot be used (it already does something), or null. */
  validate?: (accelerator: string) => string | null;
  onChange: (accelerator: string) => void;
}): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setRecording(false);
        setProblem(null);
        return;
      }
      // A bare modifier is the user on the way to a chord.
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const accelerator = chordFromEvent(event);
      if (!accelerator) {
        setProblem("Hold ⌘ or ⌥ with another key.");
        return;
      }
      const conflict = validate?.(accelerator) ?? null;
      if (conflict) {
        setProblem(conflict);
        return;
      }
      setRecording(false);
      setProblem(null);
      onChange(accelerator);
      buttonRef.current?.focus();
    };
    // Capture phase: the app's own shortcuts must not fire while recording.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onChange, recording, validate]);

  return (
    <span className="settings-shortcut-field">
      <button
        ref={buttonRef}
        type="button"
        className="settings-button"
        aria-label={ariaLabel}
        aria-pressed={recording}
        onClick={() => {
          setProblem(null);
          setRecording((active) => !active);
        }}
        onBlur={() => setRecording(false)}
      >
        {recording ? "Press a shortcut…" : formatChord(value)}
      </button>
      {value !== defaultValue ? (
        <button
          type="button"
          className="settings-button"
          aria-label={`Reset ${ariaLabel} to ${formatChord(defaultValue)}`}
          onClick={() => onChange(defaultValue)}
        >
          Reset
        </button>
      ) : null}
      {problem ? (
        <span className="settings-row-desc" role="status">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
