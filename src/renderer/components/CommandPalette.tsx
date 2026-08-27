import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { Command, FileText, Folder, MessageSquare, Quote, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  highlightSegments,
  searchFilePaths,
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

/**
 * Scope tabs. One overlay serves every surface — ⌘K opens it on `all`, ⌘P on
 * `files`. Each scope names the groups it shows, in display order.
 */
export type PaletteScope = "all" | "agents" | "files" | "actions" | "settings";

const SCOPE_TABS: ReadonlyArray<{ scope: PaletteScope; label: string }> = [
  { scope: "all", label: "All" },
  { scope: "agents", label: "Agents" },
  { scope: "files", label: "Files" },
  { scope: "actions", label: "Actions" },
  { scope: "settings", label: "Settings" }
];

// Sessions lead the mixed list: the thing a user reaches for by name is almost
// always a running agent, and files/actions stay one keystroke away via tabs.
const SCOPE_GROUPS: Record<PaletteScope, PaletteGroup[]> = {
  all: ["Sessions", "Files", "Actions", "Settings", "Projects", "Messages"],
  agents: ["Sessions", "Projects", "Messages"],
  files: ["Files"],
  actions: ["Actions"],
  settings: ["Settings"]
};

// Argmax names its own surfaces: a session is the agent a user is talking to.
const GROUP_LABEL: Record<PaletteGroup, string> = {
  Actions: "Actions",
  Sessions: "Agents",
  Projects: "Projects",
  Files: "Files",
  Messages: "Messages",
  Settings: "Settings"
};

// With no query these groups list what the user touched last, so the header
// says so. Actions and Settings are static catalogs — "Recent" would lie.
const RECENT_GROUPS = new Set<PaletteGroup>(["Sessions", "Projects", "Files", "Messages"]);

const SCOPE_PLACEHOLDER: Record<PaletteScope, string> = {
  all: "Search agents, files, actions…",
  agents: "Search agents…",
  files: "Search files…",
  actions: "Search actions…",
  settings: "Search settings…"
};

// Fallback glyph when an item carries no icon of its own. Actions each set their
// own; the homogeneous groups share one so a row stays typed once results mix.
const GROUP_ICON: Record<PaletteGroup, LucideIcon> = {
  Actions: Command,
  Sessions: MessageSquare,
  Projects: Folder,
  Files: FileText,
  Messages: Quote,
  Settings: SlidersHorizontal
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
  /** Scope the overlay opens on. ⌘K passes `all`, ⌘P passes `files`. */
  initialScope?: PaletteScope;
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
  initialScope = "all",
  searchMessages,
  fileSource = null,
  loadFiles,
  onFilePick
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>(initialScope);
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

  // Document-level Esc + outside-click via the shared hook means Esc works even
  // if focus drifts to a result row (e.g. via screen-reader navigation).
  useDismissOnOutsideOrEscape(paletteRef, open, onClose, undefined, { trapFocus: true });
  // Cache the loaded path list across keystrokes within a single palette
  // session. Keyed by `${kind}:${id}` so switching workspace/project between
  // opens invalidates correctly.
  const filesCacheKeyRef = useRef<string | null>(null);
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      messageTokenRef.current += 1;
      filesTokenRef.current += 1;
      setQuery("");
      setSelectedIndex(0);
      setMessageHits([]);
      setMessagesRunning(false);
      setFilePaths([]);
      setFilesRunning(false);
      filesCacheKeyRef.current = null;
      return;
    }
    // Re-opening with a different shortcut (⌘K vs ⌘P) re-selects the tab.
    setScope(initialScope);
    inputRef.current?.focus();
  }, [open, initialScope]);

  const visibleGroups = useMemo(() => SCOPE_GROUPS[scope], [scope]);
  const showsGroup = useCallback(
    (group: PaletteGroup): boolean => visibleGroups.includes(group),
    [visibleGroups]
  );
  // The Files tab is a file picker: it lists recents with an empty query, so
  // the path list loads on open instead of waiting for a first keystroke.
  const filesEagerly = showsGroup("Files") && visibleGroups.length === 1;

  // Debounced message backend — only when query is long enough to be useful.
  useEffect(() => {
    if (!open || !searchMessages || !showsGroup("Messages")) {
      messageTokenRef.current += 1;
      setMessageHits([]);
      setMessagesRunning(false);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_MESSAGE_QUERY_LENGTH) {
      messageTokenRef.current += 1;
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
  }, [open, query, searchMessages, showsGroup]);

  // Lazy file-list load — fires on the first non-empty keystroke, or right
  // away on the Files tab. Cached for the palette session keyed by source.
  useEffect(() => {
    if (!open || !fileSource || !loadFiles || !showsGroup("Files")) {
      filesTokenRef.current += 1;
      setFilePaths([]);
      setFilesRunning(false);
      return;
    }
    const cacheKey = `${fileSource.kind}:${fileSource.id}`;
    if (filesCacheKeyRef.current === cacheKey) return;
    if (query.trim().length === 0 && !filesEagerly) {
      filesTokenRef.current += 1;
      filesCacheKeyRef.current = null;
      setFilePaths([]);
      setFilesRunning(false);
      return;
    }
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
  }, [open, fileSource, loadFiles, query, filesEagerly, showsGroup]);

  const fileHits = useMemo<PaletteHit[]>(() => {
    if (!open || !onFilePick || filePaths.length === 0) return [];
    const trimmed = query.trim();
    if (!trimmed && !filesEagerly) return [];
    return searchFilePaths(filePaths, trimmed, MAX_PER_GROUP).map((path) => ({
      item: {
        id: `file:${path}`,
        label: basename(path),
        subtitle: dirname(path) || undefined,
        group: "Files" as const,
        run: () => onFilePick(path)
      },
      labelRanges: null,
      subtitleRanges: null
    }));
  }, [filePaths, filesEagerly, onFilePick, open, query]);

  // Run uFuzzy synchronously on each keystroke against the local command catalog.
  // Files are ranked separately by full path, then capped before row creation.
  const localHits = useMemo<PaletteHit[]>(() => {
    if (!open) return [];
    return searchPaletteItems(commands, query);
  }, [commands, query, open]);

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
    for (const group of visibleGroups) {
      if (group === "Files") {
        for (const hit of fileHits) {
          rows.push({ kind: "hit", hit, group });
        }
        continue;
      }
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
  }, [fileHits, localHits, messageHits, visibleGroups]);

  const selectScope = useCallback((next: PaletteScope): void => {
    setScope(next);
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const cycleScope = useCallback(
    (step: 1 | -1): void => {
      const current = SCOPE_TABS.findIndex((tab) => tab.scope === scope);
      const next = (current + step + SCOPE_TABS.length) % SCOPE_TABS.length;
      selectScope(SCOPE_TABS[next].scope);
    },
    [scope, selectScope]
  );

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
    const active = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    // Guard scrollIntoView for environments without layout (jsdom) — production
    // browsers always have it, but the App test harness doesn't stub it.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, open]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // Tab changes the filter instead of moving focus — the input is the only
    // thing that should ever hold focus while the overlay is open. The focus
    // trap in useDismissOnOutsideOrEscape catches Tab from anywhere else.
    if (event.key === "Tab") {
      event.preventDefault();
      cycleScope(event.shiftKey ? -1 : 1);
      return;
    }
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
        <label className="command-palette-input-wrap">
          <input
            ref={inputRef}
            className="command-palette-input"
            type="search"
            placeholder={SCOPE_PLACEHOLDER[scope]}
            aria-label="Command palette query"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
        <div className="command-palette-scopes">
          <div className="command-palette-tabs" role="tablist" aria-label="Search filter">
            {SCOPE_TABS.map((tab) => {
              const isActive = tab.scope === scope;
              return (
                <button
                  key={tab.scope}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="command-palette-results"
                  tabIndex={isActive ? 0 : -1}
                  className={`command-palette-tab${isActive ? " selected" : ""}`}
                  // Keep the caret in the input when a tab is clicked.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectScope(tab.scope)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      cycleScope(1);
                    } else if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      cycleScope(-1);
                    }
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <span className="command-palette-count" aria-hidden="true">
            {(messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH) || filesRunning
              ? "searching…"
              : totalCount > 0
                ? `${totalCount} found`
                : trimmedQuery.length === 0
                  ? "type to filter"
                  : "no matches"}
          </span>
        </div>
        <ul
          ref={resultsRef}
          id="command-palette-results"
          className="command-palette-results"
          role="listbox"
          aria-label="Command results"
        >
          {showingEmptyState ? (
            <li className="command-palette-empty" role="status">
              <span className="command-palette-empty-mark" aria-hidden="true">∅</span>
              <span className="command-palette-empty-text">
                {trimmedQuery.length > 0
                  ? "No matches — try shorter terms or another filter."
                  : scope === "files" && !fileSource
                    ? "Open a session or project to search its files."
                    : `Start typing to search ${scopeNoun(scope)}.`}
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
                    <span className="command-palette-group-label">
                      {trimmedQuery.length === 0 && RECENT_GROUPS.has(row.group)
                        ? `Recent ${GROUP_LABEL[row.group]}`
                        : GROUP_LABEL[row.group]}
                    </span>
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
                  <RowIcon
                    icon={(row.kind === "hit" ? row.hit.item.icon : undefined) ?? GROUP_ICON[row.group]}
                  />
                  {row.kind === "hit" ? (
                    <span className="command-palette-result-body">
                      <PaletteHitRow hit={row.hit} />
                    </span>
                  ) : (
                    <span className="command-palette-result-body stacked">
                      <MessageHitRow hit={row.hit} />
                    </span>
                  )}
                  {row.kind === "hit" && row.hit.item.meta ? (
                    <span className="command-palette-result-meta">
                      <HighlightedText text={row.hit.item.meta} ranges={row.hit.subtitleRanges} />
                    </span>
                  ) : null}
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
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span className="command-palette-footer-sep">·</span>
          <span><kbd>⏎</kbd> open</span>
          <span className="command-palette-footer-sep">·</span>
          <span><kbd>⇥</kbd><kbd>⇧⇥</kbd> change filter</span>
          <span className="command-palette-footer-sep">·</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}

function scopeNoun(scope: PaletteScope): string {
  switch (scope) {
    case "all":
      return "agents, files, actions, and settings";
    case "agents":
      return "agents, projects, and messages";
    case "files":
      return "files in the active workspace";
    case "actions":
      return "actions";
    case "settings":
      return "settings";
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

function RowIcon({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return (
    <span className="command-palette-icon" aria-hidden="true">
      <Icon size={14} strokeWidth={1.5} />
    </span>
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
