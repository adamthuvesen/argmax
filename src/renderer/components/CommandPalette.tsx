import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  highlightSegments,
  searchPaletteItems,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem
} from "../lib/paletteSearch.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";

export type { PaletteGroup, PaletteItem } from "../lib/paletteSearch.js";

export type PaletteCommand = PaletteItem;

const MAX_PER_GROUP = 8;
const MESSAGE_DEBOUNCE_MS = 150;
const MIN_MESSAGE_QUERY_LENGTH = 3;
const MAX_FILE_RESULTS = 200;

const GROUP_ORDER: PaletteGroup[] = ["Actions", "Files", "Projects", "Messages", "Sessions"];

const GROUP_SIGIL: Record<PaletteGroup, string> = {
  Actions: "A",
  Sessions: "S",
  Projects: "P",
  Files: "F",
  Messages: "M"
};

export interface PaletteFileSource {
  kind: "workspace" | "project";
  id: string;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export interface MessageHit {
  /** Stable key — `${sessionId}:${eventId}`. */
  id: string;
  sessionId: string;
  /** Friendly title to show (workspace task label + project name). */
  label: string;
  /** Renderable snippet text. May contain bold spans for matched tokens. */
  snippetSegments: Array<{ text: string; matched: boolean }>;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
  /**
   * Optional async backend for the "Messages" scope. Called with the trimmed
   * query (length >= 3) after a debounce; returns up to `limit` hits.
   */
  searchMessages?: (query: string, limit: number) => Promise<MessageHit[]>;
  /**
   * Optional context for the "Files" scope. When set, file paths from the
   * given workspace or project flow through the palette as `PaletteItem`s
   * grouped under "Files". Files are loaded lazily on first non-empty query
   * and cached for the palette session. Picking a file calls `onFilePick`.
   */
  fileSource?: PaletteFileSource | null;
  loadFiles?: (source: PaletteFileSource) => Promise<string[]>;
  onFilePick?: (path: string) => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
  searchMessages,
  fileSource = null,
  loadFiles,
  onFilePick
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [messageHits, setMessageHits] = useState<MessageHit[]>([]);
  const [messagesRunning, setMessagesRunning] = useState(false);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [filesRunning, setFilesRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLUListElement | null>(null);
  const messageTokenRef = useRef(0);
  const filesTokenRef = useRef(0);

  // Document-level Esc + outside-click via the shared hook. Esc previously
  // depended on the input's onKeyDown which only fires while the input has
  // focus — adopting the hook means Esc works even if focus drifted to a
  // result row (e.g. via screen-reader navigation).
  useDismissOnOutsideOrEscape(paletteRef, open, onClose, undefined, { trapFocus: true });
  // Cache the loaded path list across keystrokes within a single palette
  // session. Keyed by `${kind}:${id}` so switching workspace/project between
  // opens invalidates correctly.
  const filesCacheKeyRef = useRef<string | null>(null);
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      setMessageHits([]);
      setMessagesRunning(false);
      setFilePaths([]);
      setFilesRunning(false);
      filesCacheKeyRef.current = null;
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  // Debounced message backend — only when query is long enough to be useful.
  useEffect(() => {
    if (!open || !searchMessages) {
      setMessageHits([]);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_MESSAGE_QUERY_LENGTH) {
      setMessageHits([]);
      setMessagesRunning(false);
      return;
    }
    const token = ++messageTokenRef.current;
    setMessagesRunning(true);
    const handle = window.setTimeout(() => {
      void searchMessages(trimmed, MAX_PER_GROUP)
        .then((hits) => {
          if (token !== messageTokenRef.current) return;
          setMessageHits(hits);
        })
        .catch(() => {
          if (token !== messageTokenRef.current) return;
          setMessageHits([]);
        })
        .finally(() => {
          if (token === messageTokenRef.current) {
            setMessagesRunning(false);
          }
        });
    }, MESSAGE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, query, searchMessages]);

  // Lazy file-list load — fires on first non-empty keystroke when a file
  // source is available. Cached for the palette session keyed by source.
  useEffect(() => {
    if (!open || !fileSource || !loadFiles) {
      setFilePaths([]);
      setFilesRunning(false);
      return;
    }
    const cacheKey = `${fileSource.kind}:${fileSource.id}`;
    if (filesCacheKeyRef.current === cacheKey) return;
    if (query.trim().length === 0) return;
    const token = ++filesTokenRef.current;
    filesCacheKeyRef.current = cacheKey;
    setFilesRunning(true);
    void loadFiles(fileSource)
      .then((paths) => {
        if (token !== filesTokenRef.current) return;
        setFilePaths(paths);
      })
      .catch(() => {
        if (token !== filesTokenRef.current) return;
        setFilePaths([]);
      })
      .finally(() => {
        if (token === filesTokenRef.current) setFilesRunning(false);
      });
  }, [open, fileSource, loadFiles, query]);

  // Materialize Files PaletteItems from the cached path list. Cheap memo —
  // only rebuilds when the path list changes (once per palette session).
  const fileItems = useMemo<PaletteItem[]>(() => {
    if (!onFilePick || filePaths.length === 0) return [];
    return filePaths.slice(0, MAX_FILE_RESULTS).map((path) => ({
      id: `file:${path}`,
      label: basename(path),
      subtitle: dirname(path) || undefined,
      group: "Files" as const,
      run: () => onFilePick(path)
    }));
  }, [filePaths, onFilePick]);

  const combinedCommands = useMemo<PaletteItem[]>(
    () => (fileItems.length > 0 ? [...commands, ...fileItems] : commands),
    [commands, fileItems]
  );

  // Run uFuzzy synchronously on each keystroke against the merged catalog
  // (commands + lazy-loaded files). Cheap for the local catalog.
  const localHits = useMemo<PaletteHit[]>(() => {
    if (!open) return [];
    return searchPaletteItems(combinedCommands, query);
  }, [combinedCommands, query, open]);

  // Flatten hits in display order so keyboard nav has a single linear index.
  // Each row carries its group so we can insert headers without breaking the
  // index/option mapping.
  const flatRows = useMemo(() => {
    type Row =
      | { kind: "hit"; hit: PaletteHit; group: PaletteGroup }
      | { kind: "message"; hit: MessageHit; group: "Messages" };

    const byGroup = new Map<PaletteGroup, PaletteHit[]>();
    for (const hit of localHits) {
      const list = byGroup.get(hit.item.group) ?? [];
      if (list.length < MAX_PER_GROUP) {
        list.push(hit);
        byGroup.set(hit.item.group, list);
      }
    }

    const rows: Row[] = [];
    for (const group of GROUP_ORDER) {
      if (group === "Messages") {
        for (const hit of messageHits.slice(0, MAX_PER_GROUP)) {
          rows.push({ kind: "message", hit, group: "Messages" });
        }
        continue;
      }
      const list = byGroup.get(group);
      if (!list) continue;
      for (const hit of list) {
        rows.push({ kind: "hit", hit, group });
      }
    }
    return rows;
  }, [localHits, messageHits]);

  useEffect(() => {
    if (selectedIndex >= flatRows.length) {
      setSelectedIndex(0);
    }
  }, [flatRows, selectedIndex]);

  // Keep the active row visible when ArrowUp/Down moves selection past the
  // viewport. `block: "nearest"` avoids jumping when the row is already in
  // view — long result lists otherwise hide the active row off-screen.
  useEffect(() => {
    if (!open) return;
    const list = resultsRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(".command-palette-result.selected");
    // Guard scrollIntoView for environments without layout (jsdom) — production
    // browsers always have it, but the App test harness doesn't stub it.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, open]);

  const groupCounts = useMemo(() => {
    const counts: Partial<Record<PaletteGroup, number>> = {};
    for (const row of flatRows) {
      counts[row.group] = (counts[row.group] ?? 0) + 1;
    }
    return counts;
  }, [flatRows]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(flatRows.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = flatRows[selectedIndex];
      if (!row) return;
      onClose();
      if (row.kind === "hit") {
        row.hit.item.run();
      } else {
        row.hit.run();
      }
      return;
    }
    // Esc is handled by useDismissOnOutsideOrEscape at the document level,
    // so it works regardless of which element holds focus inside the palette.
  };

  const trimmedQuery = query.trim();
  const anyBackgroundLoading = messagesRunning || filesRunning;
  const showingEmptyState =
    flatRows.length === 0 &&
    !anyBackgroundLoading &&
    (trimmedQuery.length === 0 || trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH);

  const totalCount = flatRows.length;
  let lastGroup: PaletteGroup | null = null;

  return (
    <div
      className="command-palette-overlay"
      role="dialog"
      aria-label="Command palette"
    >
      <div className="command-palette" ref={paletteRef}>
        <div className="command-palette-header" aria-hidden="true">
          <span className="command-palette-scope">
            <span className="command-palette-scope-mark">cmd</span>
            <kbd className="command-palette-scope-kbd">⌘K</kbd>
          </span>
          <span className="command-palette-count">
            {(messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH) || filesRunning
              ? "searching…"
              : totalCount > 0
                ? `${totalCount} found`
                : trimmedQuery.length === 0
                  ? "type to filter"
                  : "no matches"}
          </span>
        </div>
        <label className="command-palette-input-wrap">
          <input
            ref={inputRef}
            className="command-palette-input"
            type="search"
            placeholder={fileSource ? "command, session, project, file, or message" : "command, session, project, or message"}
            aria-label="Command palette query"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
        <ul
          ref={resultsRef}
          className="command-palette-results"
          role="listbox"
          aria-label="Command results"
        >
          {showingEmptyState ? (
            <li className="command-palette-empty" role="status">
              <span className="command-palette-empty-mark" aria-hidden="true">∅</span>
              <span className="command-palette-empty-text">
                {trimmedQuery.length === 0
                  ? fileSource
                    ? "Start typing to filter actions, sessions, projects, files, or messages."
                    : "Start typing to filter actions, sessions, projects, or messages."
                  : "No matches — try shorter terms or a different scope."}
              </span>
            </li>
          ) : null}
          {flatRows.map((row, index) => {
            const groupHeader = row.group !== lastGroup;
            lastGroup = row.group;
            const isSelected = index === selectedIndex;
            const key = row.kind === "hit" ? row.hit.item.id : row.hit.id;
            return (
              <Fragment key={key}>
                {groupHeader ? (
                  <li className="command-palette-group" role="presentation">
                    <span className="command-palette-group-rule" aria-hidden="true" />
                    <span className="command-palette-group-label">{row.group}</span>
                    <span className="command-palette-group-count" aria-hidden="true">
                      / {String(groupCounts[row.group] ?? 0).padStart(2, "0")}
                    </span>
                    <span className="command-palette-group-rule" aria-hidden="true" />
                  </li>
                ) : null}
                <li
                  role="option"
                  aria-selected={isSelected}
                  className={`command-palette-result${isSelected ? " selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onClose();
                    if (row.kind === "hit") {
                      row.hit.item.run();
                    } else {
                      row.hit.run();
                    }
                  }}
                >
                  <span className="command-palette-sigil" aria-hidden="true">{GROUP_SIGIL[row.group]}</span>
                  <span className="command-palette-result-body">
                    {row.kind === "hit" ? (
                      <PaletteHitRow hit={row.hit} />
                    ) : (
                      <MessageHitRow hit={row.hit} />
                    )}
                  </span>
                  <span className="command-palette-result-hint" aria-hidden="true">
                    <kbd>⏎</kbd>
                  </span>
                </li>
              </Fragment>
            );
          })}
          {messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH ? (
            <li className="command-palette-loading" role="status">
              <span className="command-palette-loading-dot" aria-hidden="true" />
              Searching messages…
            </li>
          ) : null}
          {filesRunning ? (
            <li className="command-palette-loading" role="status">
              <span className="command-palette-loading-dot" aria-hidden="true" />
              Loading files…
            </li>
          ) : null}
        </ul>
        <footer className="command-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span className="command-palette-footer-sep">·</span>
          <span><kbd>⏎</kbd> open</span>
          <span className="command-palette-footer-sep">·</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}

function PaletteHitRow({ hit }: { hit: PaletteHit }): JSX.Element {
  const { item, labelRanges, subtitleRanges } = hit;
  return (
    <>
      <span className="command-palette-result-label">
        <HighlightedText text={item.label} ranges={labelRanges} />
      </span>
      {item.subtitle ? (
        <span className="command-palette-result-subtitle">
          <HighlightedText text={item.subtitle} ranges={subtitleRanges} />
        </span>
      ) : null}
    </>
  );
}

function MessageHitRow({ hit }: { hit: MessageHit }): JSX.Element {
  return (
    <>
      <span className="command-palette-result-label">{hit.label}</span>
      <span className="command-palette-result-snippet">
        {hit.snippetSegments.map((segment, index) =>
          segment.matched ? (
            <mark key={index}>{segment.text}</mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </span>
    </>
  );
}

function HighlightedText({
  text,
  ranges
}: {
  text: string;
  ranges: number[] | null;
}): JSX.Element {
  const segments = highlightSegments(text, ranges);
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}
