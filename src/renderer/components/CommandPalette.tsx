import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  subtitle?: string;
  group: "Actions" | "Sessions" | "Projects" | "Help";
  run: () => void;
}

const MAX_RESULTS = 40;

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const lh = haystack.toLowerCase();
  const ln = needle.toLowerCase();
  if (lh.includes(ln)) return 100 - lh.indexOf(ln);
  // Tolerant character-by-character match for non-contiguous queries.
  let h = 0;
  let matched = 0;
  for (let n = 0; n < ln.length; n++) {
    while (h < lh.length && lh[h] !== ln[n]) h++;
    if (h >= lh.length) return 0;
    matched++;
    h++;
  }
  return matched / ln.length;
}

export function CommandPalette({
  open,
  commands,
  onClose
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    if (!open) return [] as PaletteCommand[];
    const scored = commands
      .map((command) => ({
        command,
        score: Math.max(
          fuzzyScore(command.label, query),
          command.subtitle ? fuzzyScore(command.subtitle, query) * 0.6 : 0
        )
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.command);
    return scored;
  }, [commands, query, open]);

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(0);
    }
  }, [results, selectedIndex]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, results.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selection = results[selectedIndex];
      if (!selection) return;
      onClose();
      selection.run();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="command-palette-overlay"
      role="dialog"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-palette">
        <input
          ref={inputRef}
          className="command-palette-input"
          type="search"
          placeholder="Type a command, session, or project…"
          aria-label="Command palette query"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <ul className="command-palette-results" role="listbox" aria-label="Command results">
          {results.length === 0 ? (
            <li className="command-palette-empty" role="status">
              No matches.
            </li>
          ) : (
            results.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === selectedIndex}
                className={`command-palette-result${index === selectedIndex ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onClose();
                  command.run();
                }}
              >
                <span className="command-palette-result-group">{command.group}</span>
                <span className="command-palette-result-label">{command.label}</span>
                {command.subtitle ? (
                  <span className="command-palette-result-subtitle">{command.subtitle}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
