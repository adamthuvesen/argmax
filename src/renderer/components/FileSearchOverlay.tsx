import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { listFilesFor, type ReviewSourceKind } from "../lib/listFiles.js";

const MAX_VISIBLE_RESULTS = 100;

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp",
  "sh", "bash", "zsh",
  "css", "scss", "less", "html", "json", "yaml", "yml", "toml", "sql", "xml"
]);

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function fileGlyph(name: string): string {
  const ext = extensionOf(name);
  if (!ext) return "≡";
  if (CODE_EXTENSIONS.has(ext)) return "</>";
  if (ext === "md" || ext === "mdx" || ext === "txt") return "¶";
  return "≡";
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

  const countLabel =
    loadState === "loading"
      ? "loading…"
      : loadState === "error"
        ? "error"
        : results.length === 0
          ? query.trim().length === 0
            ? `${paths.length} files`
            : "no matches"
          : `${results.length}${results.length === MAX_VISIBLE_RESULTS ? "+" : ""} found`;

  const scopeLabel = sourceKind === "workspace" ? "workspace" : "project";

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
        <div className="search-header" aria-hidden="true">
          <span className="search-scope">
            <span className="search-scope-mark">files</span>
            <span className="search-scope-target">/ {scopeLabel}</span>
            <kbd className="search-scope-kbd">⌘P</kbd>
          </span>
          <span className="search-count">{countLabel}</span>
        </div>
        <label className="search-input-wrap">
          <span className="search-prompt" aria-hidden="true">~/</span>
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder="Search files…"
            aria-label={ariaLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {loadState === "error" ? (
          <p className="search-error" role="alert">
            {loadError}
          </p>
        ) : null}
        <ul className="search-results" role="listbox" aria-label="File search results">
          {loadState === "ready" && results.length === 0 ? (
            <li className="search-empty" role="status">
              <span className="search-empty-mark" aria-hidden="true">∅</span>
              <span className="search-empty-text">
                {query.trim().length === 0
                  ? "Type a filename, path fragment, or extension (e.g. .ts)."
                  : "No matches — try shorter terms or an extension."}
              </span>
            </li>
          ) : null}
          {results.map((path, index) => {
            const name = basename(path);
            const dir = dirname(path);
            const dirParts = dir ? dir.split("/") : [];
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
                <span className="file-search-glyph" aria-hidden="true">{fileGlyph(name)}</span>
                <span className="file-search-meta">
                  <span className="file-search-result-name">{name}</span>
                  {dirParts.length > 0 ? (
                    <span className="file-search-result-path">
                      {dirParts.map((part, partIndex) => (
                        <span key={partIndex} className="file-search-result-crumb">
                          {partIndex > 0 ? (
                            <span className="file-search-result-sep" aria-hidden="true">/</span>
                          ) : null}
                          <span>{part}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                <span className="file-search-hint" aria-hidden="true">
                  <kbd>⏎</kbd>
                </span>
              </li>
            );
          })}
        </ul>
        <footer className="search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span className="search-footer-sep">·</span>
          <span><kbd>⏎</kbd> open</span>
          <span className="search-footer-sep">·</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
