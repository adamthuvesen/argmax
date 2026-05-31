import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { parseFtsSnippet } from "../lib/paletteSearch.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";

export interface SearchHit {
  sessionId: string;
  eventId: string;
  snippet: string;
  rank: number;
}

export function SearchOverlay({
  open,
  onClose,
  onSelectSession,
  sessionLabelById
}: {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  /** Friendly "Project · Task" label for each session, used in result rows. */
  sessionLabelById: Map<string, string>;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const tokenRef = useRef(0);
  useDismissOnOutsideOrEscape(modalRef, open, onClose, undefined, { trapFocus: true });
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      tokenRef.current += 1;
      return;
    }
    tokenRef.current += 1;
    setQuery("");
    setHits([]);
    setRunning(false);
    setError(null);
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [open]);

  const runSearch = useCallback(async (rawQuery: string): Promise<void> => {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      tokenRef.current += 1;
      setHits([]);
      setRunning(false);
      setError(null);
      return;
    }
    if (!window.argmax) {
      setError("Open the Tauri app window to search sessions.");
      return;
    }
    const token = ++tokenRef.current;
    setRunning(true);
    setError(null);
    try {
      const result = await window.argmax.session.search({ query: trimmed, limit: 50 });
      if (token !== tokenRef.current) return;
      setHits(result);
      setSelectedIndex(0);
    } catch (caught) {
      if (token !== tokenRef.current) return;
      setError(caught instanceof Error ? caught.message : "Search failed.");
      setHits([]);
    } finally {
      if (token === tokenRef.current) {
        setRunning(false);
      }
    }
  }, []);

  // Debounce by a short tick so each keystroke doesn't fire an IPC. 150ms is
  // long enough to dedupe a fast typist and short enough that results feel
  // synchronous once they stop.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      void runSearch(query);
    }, 150);
    return () => clearTimeout(handle);
  }, [query, open, runSearch]);

  // Keep the selected hit visible during ArrowUp/Down navigation. `block:
  // "nearest"` is unintrusive for hits already on screen and only scrolls
  // when the row would otherwise be clipped.
  useEffect(() => {
    if (!open) return;
    const list = resultsRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(".search-result.selected");
    // Guard scrollIntoView — undefined in jsdom layout-less environments.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, open]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Esc handled by useDismissOnOutsideOrEscape at the document level.
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(hits.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const target = hits[selectedIndex];
      if (!target) return;
      event.preventDefault();
      onSelectSession(target.sessionId);
      onClose();
    }
  };

  return (
    <div
      className="search-overlay"
      role="dialog"
      aria-label="Search sessions"
      aria-modal="true"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="search-modal" ref={modalRef}>
        <div className="search-input-wrap">
          <Search size={14} aria-hidden="true" />
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder="Search across sessions…"
            aria-label="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {error ? (
          <p className="search-error" role="alert">
            {error}
          </p>
        ) : null}
        <ul ref={resultsRef} className="search-results" role="listbox" aria-label="Search results">
          {!running && query && hits.length === 0 && !error ? (
            <li className="search-empty" role="status">
              No matches — try shorter terms.
            </li>
          ) : null}
          {hits.map((hit, index) => {
            const segments = parseFtsSnippet(hit.snippet);
            return (
              <li
                key={hit.eventId}
                role="option"
                aria-selected={index === selectedIndex}
                className={`search-result${index === selectedIndex ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelectSession(hit.sessionId);
                  onClose();
                }}
              >
                <span className="search-result-session">
                  {sessionLabelById.get(hit.sessionId) ?? "Unknown session"}
                </span>
                <span className="search-result-snippet">
                  {segments.map((segment, segmentIndex) =>
                    segment.matched ? (
                      <mark key={segmentIndex}>{segment.text}</mark>
                    ) : (
                      <span key={segmentIndex}>{segment.text}</span>
                    )
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
