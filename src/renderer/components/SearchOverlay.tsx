import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface SearchHit {
  sessionId: string;
  eventId: string;
  snippet: string;
  rank: number;
}

export function SearchOverlay({
  open,
  onClose,
  onSelectSession
}: {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);

  // Reset state every time the overlay re-opens.
  useEffect(() => {
    if (!open) return;
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
      setHits([]);
      setRunning(false);
      setError(null);
      return;
    }
    if (!window.argmax) {
      setError("Open the Electron app window to search sessions.");
      return;
    }
    const token = ++tokenRef.current;
    setRunning(true);
    setError(null);
    try {
      // Wrap in double quotes so FTS5 treats the input as a phrase rather
      // than a query language. Escape embedded quotes so a `"` in the user
      // input doesn't break the syntax.
      const escaped = trimmed.replace(/"/g, '""');
      const result = await window.argmax.session.search({ query: `"${escaped}"`, limit: 50 });
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

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
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
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="search-modal">
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
        <ul className="search-results" role="listbox" aria-label="Search results">
          {!running && query && hits.length === 0 && !error ? (
            <li className="search-empty" role="status">
              No matches.
            </li>
          ) : null}
          {hits.map((hit, index) => (
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
              <span className="search-result-session">{hit.sessionId}</span>
              <span
                className="search-result-snippet"
                // FTS5's snippet() returns inert markup with <b>…</b> markers.
                // The text is user-generated event content; we trust SQLite's
                // snippet() to only emit our configured tags around tokens,
                // but we still HTML-escape anything else via textContent below.
                dangerouslySetInnerHTML={{ __html: renderSnippet(hit.snippet) }}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Render an FTS5 snippet that contains literal `<b>`/`</b>` markers around
 * matched tokens. Escapes every other byte so an event message that itself
 * contains HTML can't smuggle a script tag past `dangerouslySetInnerHTML`.
 * Splits on the marker, escapes each segment, then rejoins with `<b>…</b>`.
 */
function renderSnippet(raw: string): string {
  return raw
    .split(/(<\/?b>)/g)
    .map((segment) => (segment === "<b>" || segment === "</b>" ? segment : escapeHtml(segment)))
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
