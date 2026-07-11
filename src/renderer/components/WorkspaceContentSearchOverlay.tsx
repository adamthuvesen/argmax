import { FileText, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import type { WorkspaceContentSearchFile, WorkspaceContentSearchResult } from "../../shared/types.js";

const DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 2;

interface PaletteFileSource {
  kind: "workspace" | "project";
  id: string;
}
/**
 * Workspace-wide content search (⌘⇧F). Driven by `git grep` on the main
 * process; each file row groups the per-file match snippets returned by the
 * backend. Picking any row calls `onPick(path)` — wired in App.tsx to the
 * active surface's review-pane "open file" handler so results land in the
 * same panel that ⌘P file-open uses.
 *
 * Disabled when no `source` is registered (no active workspace/project) —
 * the modal still opens so the user gets the "open a project first" empty
 * state instead of a silent no-op on the keypress.
 */
export function WorkspaceContentSearchOverlay({
  open,
  onClose,
  source,
  onPick
}: {
  open: boolean;
  onClose: () => void;
  source: PaletteFileSource | null;
  onPick: ((path: string) => void) | null;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<WorkspaceContentSearchResult>({ files: [], truncated: false });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const tokenRef = useRef(0);

  // Document-level Esc + outside-click via the shared hook. Esc no longer
  // depends on the overlay div catching focus.
  useDismissOnOutsideOrEscape(modalRef, open, onClose, undefined, { trapFocus: true });

  useEffect(() => {
    if (!open) {
      tokenRef.current += 1;
      return;
    }
    tokenRef.current += 1;
    setQuery("");
    setResult({ files: [], truncated: false });
    setRunning(false);
    setError(null);
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // One linear list of "selectable rows" so keyboard nav has a single index.
  // Each file contributes 1 (file header) + N (matches) rows; clicking the
  // header opens the file at its first match line, clicking a match row
  // opens the file at that specific line.
  const flatRows = useMemo(() => {
    type Row = { kind: "file"; file: WorkspaceContentSearchFile } | {
      kind: "match";
      file: WorkspaceContentSearchFile;
      matchIndex: number;
    };
    const rows: Row[] = [];
    for (const file of result.files) {
      rows.push({ kind: "file", file });
      for (let i = 0; i < file.matches.length; i += 1) {
        rows.push({ kind: "match", file, matchIndex: i });
      }
    }
    return rows;
  }, [result.files]);

  useEffect(() => {
    if (selectedIndex >= flatRows.length) setSelectedIndex(0);
  }, [flatRows, selectedIndex]);

  // Scroll the selected row into view when keyboard nav moves past the
  // viewport. `block: "nearest"` is a no-op when already visible.
  useEffect(() => {
    if (!open) return;
    const list = resultsRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(".search-result.selected");
    // Guard scrollIntoView — undefined in jsdom layout-less environments.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, open]);

  const runSearch = useCallback(
    async (rawQuery: string): Promise<void> => {
      const trimmed = rawQuery.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        tokenRef.current += 1;
        setResult({ files: [], truncated: false });
        setRunning(false);
        setError(null);
        return;
      }
      if (!source || !window.argmax) {
        setError(source ? "Open the Tauri app window to search files." : "Open a project to search its files.");
        return;
      }
      const token = ++tokenRef.current;
      setRunning(true);
      setError(null);
      try {
        const next = await window.argmax.workspace.grepContent({
          kind: source.kind,
          id: source.id,
          query: trimmed
        });
        if (token !== tokenRef.current) return;
        setResult(next);
        setSelectedIndex(0);
      } catch (caught) {
        if (token !== tokenRef.current) return;
        setError(caught instanceof Error ? caught.message : "Search failed.");
        setResult({ files: [], truncated: false });
      } finally {
        if (token === tokenRef.current) setRunning(false);
      }
    },
    [source]
  );

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      void runSearch(query);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, open, runSearch]);

  const commit = useCallback(
    (path: string): void => {
      if (onPick) onPick(path);
      onClose();
    },
    [onPick, onClose]
  );

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Esc handled by useDismissOnOutsideOrEscape at the document level.
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(flatRows.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const row = flatRows[selectedIndex];
      if (!row) return;
      event.preventDefault();
      commit(row.file.path);
    }
  };

  const totalFiles = result.files.length;
  const totalMatches = result.files.reduce((sum, file) => sum + file.matches.length, 0);
  const trimmedQuery = query.trim();
  const tooShort = trimmedQuery.length > 0 && trimmedQuery.length < MIN_QUERY_LENGTH;
  const summary = running
    ? "searching…"
    : trimmedQuery.length === 0
      ? "type to search file contents"
      : tooShort
        ? `enter ${MIN_QUERY_LENGTH}+ characters`
        : totalMatches === 0
          ? "no matches"
          : `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${totalFiles} file${totalFiles === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}`;

  return (
    <div
      className="search-overlay"
      role="dialog"
      aria-label="Search workspace files"
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
            placeholder={source ? "Search file contents…" : "Open a project to search file contents"}
            aria-label="Search workspace files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={!source}
          />
          <span className="search-summary" aria-live="polite">
            {summary}
          </span>
        </div>
        {error ? (
          <p className="search-error" role="alert">
            {error}
          </p>
        ) : null}
        <ul
          ref={resultsRef}
          className="search-results"
          role="listbox"
          aria-label="Workspace content search results"
        >
          {!running && trimmedQuery.length >= MIN_QUERY_LENGTH && totalMatches === 0 && !error ? (
            <li className="search-empty" role="status">
              No matches — try shorter terms.
            </li>
          ) : null}
          {flatRows.map((row, index) => {
            const isSelected = index === selectedIndex;
            if (row.kind === "file") {
              return (
                <li
                  key={`file:${row.file.path}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`search-result content-search-file${isSelected ? " selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(row.file.path);
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="content-search-file-path">{row.file.path}</span>
                  <span className="content-search-file-count" aria-hidden="true">
                    {row.file.matches.length}
                  </span>
                </li>
              );
            }
            const match = row.file.matches[row.matchIndex];
            if (!match) return null;
            return (
              <li
                key={`match:${row.file.path}:${match.line}`}
                role="option"
                aria-selected={isSelected}
                className={`search-result content-search-match${isSelected ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(row.file.path);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="content-search-match-line" aria-hidden="true">
                  {match.line}
                </span>
                <span className="content-search-match-preview">{match.preview}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
