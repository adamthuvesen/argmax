import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { listFilesFor, type ReviewSourceKind } from "../lib/listFiles.js";

const MAX_VISIBLE_RESULTS = 100;

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function filterFiles(paths: string[], query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return paths.slice(0, MAX_VISIBLE_RESULTS);
  // Two passes: basename hits first (better signal), then path hits.
  const basenameHits: string[] = [];
  const pathHits: string[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (basename(lower).includes(trimmed)) basenameHits.push(path);
    else if (lower.includes(trimmed)) pathHits.push(path);
    if (basenameHits.length >= MAX_VISIBLE_RESULTS) break;
  }
  return basenameHits.concat(pathHits).slice(0, MAX_VISIBLE_RESULTS);
}

export function FileSearchOverlay({
  open,
  onClose,
  sourceKind,
  sourceId,
  onPick
}: {
  open: boolean;
  onClose: () => void;
  sourceKind: ReviewSourceKind;
  sourceId: string;
  onPick: (path: string) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    inputRef.current?.focus();
    const token = ++tokenRef.current;
    setLoadState("loading");
    setLoadError(null);
    listFilesFor(sourceKind, sourceId)
      .then((entries) => {
        if (token !== tokenRef.current) return;
        setPaths(entries.map((entry) => entry.path));
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (token !== tokenRef.current) return;
        setPaths([]);
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : "Could not list files.");
      });
  }, [open, sourceKind, sourceId]);

  const results = useMemo(() => filterFiles(paths, query), [paths, query]);

  // Keep selectedIndex in range when the filtered list shrinks.
  useEffect(() => {
    if (selectedIndex >= results.length && results.length > 0) {
      setSelectedIndex(results.length - 1);
    } else if (results.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }, [results.length, selectedIndex]);

  const commit = useCallback((path: string): void => {
    onPick(path);
    onClose();
  }, [onPick, onClose]);

  if (!open) return null;

  const ariaLabel = sourceKind === "workspace" ? "Search files in workspace" : "Search files in project";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const target = results[selectedIndex];
      if (!target) return;
      event.preventDefault();
      commit(target);
    }
  };

  return (
    <div
      className="search-overlay"
      role="dialog"
      aria-label={ariaLabel}
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
            placeholder="Search files…"
            aria-label={ariaLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {loadState === "error" ? (
          <p className="search-error" role="alert">
            {loadError}
          </p>
        ) : null}
        <ul className="search-results" role="listbox" aria-label="File search results">
          {loadState === "ready" && results.length === 0 ? (
            <li className="search-empty" role="status">
              No matches.
            </li>
          ) : null}
          {results.map((path, index) => {
            const name = basename(path);
            const dir = dirname(path);
            return (
              <li
                key={path}
                role="option"
                aria-selected={index === selectedIndex}
                className={`search-result file-search${index === selectedIndex ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(path);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="file-search-result-name">{name}</span>
                {dir ? <span className="file-search-result-path">{dir}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
