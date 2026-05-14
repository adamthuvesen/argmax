import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  highlightSegments,
  searchPaletteItems,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem
} from "../lib/paletteSearch.js";

export type { PaletteGroup, PaletteItem } from "../lib/paletteSearch.js";

export type PaletteCommand = PaletteItem;

const MAX_PER_GROUP = 8;
const MESSAGE_DEBOUNCE_MS = 150;
const MIN_MESSAGE_QUERY_LENGTH = 3;

const GROUP_ORDER: PaletteGroup[] = ["Actions", "Sessions", "Projects", "Messages"];

const GROUP_SIGIL: Record<PaletteGroup, string> = {
  Actions: "A",
  Sessions: "S",
  Projects: "P",
  Messages: "M"
};

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
}

export function CommandPalette({
  open,
  commands,
  onClose,
  searchMessages
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [messageHits, setMessageHits] = useState<MessageHit[]>([]);
  const [messagesRunning, setMessagesRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messageTokenRef = useRef(0);
  // Capture the element that had focus before the palette opened so we can
  // restore it on close — otherwise focus drops to <body> and the keyboard
  // user loses their place.
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      setMessageHits([]);
      setMessagesRunning(false);
      const previous = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
      return;
    }
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
  }, [open]);

  // Run uFuzzy synchronously on each keystroke. Cheap for the local catalog.
  const localHits = useMemo<PaletteHit[]>(() => {
    if (!open) return [];
    return searchPaletteItems(commands, query);
  }, [commands, query, open]);

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
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const trimmedQuery = query.trim();
  const showingEmptyState =
    flatRows.length === 0 &&
    !messagesRunning &&
    (trimmedQuery.length === 0 || trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH);

  const totalCount = flatRows.length;
  let lastGroup: PaletteGroup | null = null;

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
        <div className="command-palette-header" aria-hidden="true">
          <span className="command-palette-scope">
            <span className="command-palette-scope-mark">cmd</span>
            <kbd className="command-palette-scope-kbd">⌘K</kbd>
          </span>
          <span className="command-palette-count">
            {messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH
              ? "searching…"
              : totalCount > 0
                ? `${totalCount} found`
                : trimmedQuery.length === 0
                  ? "type to filter"
                  : "no matches"}
          </span>
        </div>
        <label className="command-palette-input-wrap">
          <span className="command-palette-prompt" aria-hidden="true">&gt;</span>
          <input
            ref={inputRef}
            className="command-palette-input"
            type="search"
            placeholder="command, session, project, or message"
            aria-label="Command palette query"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
        <ul className="command-palette-results" role="listbox" aria-label="Command results">
          {showingEmptyState ? (
            <li className="command-palette-empty" role="status">
              <span className="command-palette-empty-mark" aria-hidden="true">∅</span>
              <span className="command-palette-empty-text">
                {trimmedQuery.length === 0
                  ? "Start typing to filter actions, sessions, projects, or messages."
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
                  onMouseEnter={() => setSelectedIndex(index)}
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
