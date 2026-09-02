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
import { Command, FileSearch, FileText, Folder, MessageSquare, Quote, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FileIcon } from "@react-symbols/icons/utils";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import {
  highlightSegments,
  searchFilePaths,
  searchPaletteItems,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem
} from "../lib/paletteSearch.js";
import type {
  WorkspaceContentSearchFile,
  WorkspaceContentSearchResult
} from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { WorkingNest } from "./WorkingNest.js";

export type { PaletteGroup, PaletteItem } from "../lib/paletteSearch.js";

export type PaletteCommand = PaletteItem;

const MAX_PER_GROUP = 8;
// With no query the palette is a recents list, not a result set. A mixed scope
// stacks four or five of those lists, so each one keeps its top few and the
// dialog stays short enough to read without scrolling. Typing lifts the cap.
const MAX_RECENT_PER_GROUP = 5;
const MESSAGE_DEBOUNCE_MS = 150;
const MIN_MESSAGE_QUERY_LENGTH = 3;
const CONTENT_DEBOUNCE_MS = 180;
const MIN_CONTENT_QUERY_LENGTH = 2;

const EMPTY_CONTENT_RESULT: WorkspaceContentSearchResult = { files: [], truncated: false };

/**
 * Scope tabs. One overlay serves every search surface — ⌘K opens it on `all`,
 * ⌘P on `files`, ⌘F on `messages`, ⌘⇧F on `contents`. Each scope names the
 * groups it shows, in display order.
 */
export type PaletteScope =
  | "all"
  | "agents"
  | "files"
  | "messages"
  | "contents"
  | "actions"
  | "settings";

const SCOPE_TABS: ReadonlyArray<{ scope: PaletteScope; label: string }> = [
  { scope: "all", label: "All" },
  { scope: "agents", label: "Agents" },
  { scope: "files", label: "Files" },
  { scope: "messages", label: "Messages" },
  { scope: "contents", label: "Contents" },
  { scope: "actions", label: "Actions" },
  { scope: "settings", label: "Settings" }
];

// Sessions lead the mixed list: the thing a user reaches for by name is almost
// always a running agent, and files/actions stay one keystroke away via tabs.
// `all` deliberately omits Contents: a git grep needs a checkout and costs a
// subprocess per keystroke, so it stays behind its own tab.
const SCOPE_GROUPS: Record<PaletteScope, PaletteGroup[]> = {
  all: ["Sessions", "Files", "Actions", "Settings", "Projects", "Messages"],
  agents: ["Sessions", "Projects", "Messages"],
  files: ["Files"],
  messages: ["Messages"],
  contents: ["Contents"],
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
  Contents: "File Contents",
  Settings: "Settings"
};

// With no query these groups list what the user touched last, so the header
// says so. Actions and Settings are static catalogs — "Recent" would lie, and
// Contents has nothing to show until a query runs.
const RECENT_GROUPS = new Set<PaletteGroup>(["Sessions", "Projects", "Files", "Messages"]);

const SCOPE_PLACEHOLDER: Record<PaletteScope, string> = {
  all: "Search agents, files, actions…",
  agents: "Search agents…",
  files: "Search files…",
  messages: "Search across chats…",
  contents: "Search inside files…",
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
  Contents: FileSearch,
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

/**
 * One selectable line. Content search contributes two kinds: a file header and
 * one row per matching line, so keyboard nav walks matches without leaving the
 * single linear index the rest of the palette uses.
 */
type PaletteRow =
  | { kind: "hit"; hit: PaletteHit; group: PaletteGroup }
  | { kind: "message"; hit: MessageHit; group: "Messages" }
  | { kind: "content-file"; file: WorkspaceContentSearchFile; group: "Contents" }
  | {
      kind: "content-match";
      file: WorkspaceContentSearchFile;
      matchIndex: number;
      group: "Contents";
    };

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
  /**
   * Optional `git grep` backend for the "Contents" scope. Called with the
   * trimmed query (length >= 2) after a debounce. Needs the same checkout as
   * `fileSource`, and picking any content row opens its file via `onFilePick`.
   */
  searchContents?: (query: string) => Promise<WorkspaceContentSearchResult>;
}

export function CommandPalette({
  open,
  commands,
  onClose,
  initialScope = "all",
  searchMessages,
  fileSource = null,
  loadFiles,
  onFilePick,
  searchContents
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>(initialScope);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [messageHits, setMessageHits] = useState<MessageHit[]>([]);
  const [messagesRunning, setMessagesRunning] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [filesRunning, setFilesRunning] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [contentResult, setContentResult] =
    useState<WorkspaceContentSearchResult>(EMPTY_CONTENT_RESULT);
  const [contentsRunning, setContentsRunning] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLUListElement | null>(null);
  const messageTokenRef = useRef(0);
  const filesTokenRef = useRef(0);
  const contentTokenRef = useRef(0);

  // Document-level Esc + outside-click via the shared hook means Esc works even
  // if focus drifts to a result row (e.g. via screen-reader navigation).
  useDismissOnOutsideOrEscape(paletteRef, open, onClose, undefined, { trapFocus: true });
  // Cache the loaded path list across keystrokes within a single palette
  // session. Keyed by `${kind}:${id}` so switching workspace/project between
  // opens invalidates correctly.
  const filesCacheKeyRef = useRef<string | null>(null);
  // `searchMessages` closes over the dashboard snapshot upstream, so it gets a
  // new identity on every `dashboard:delta`. Depending on it directly would
  // cancel the debounce timer many times a second while an agent streams and
  // the backend would never be called. Depend on whether one exists instead.
  const searchMessagesRef = useRef(searchMessages);
  searchMessagesRef.current = searchMessages;
  const hasMessageSearch = Boolean(searchMessages);
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      messageTokenRef.current += 1;
      filesTokenRef.current += 1;
      contentTokenRef.current += 1;
      setQuery("");
      setSelectedIndex(0);
      setMessageHits([]);
      setMessagesRunning(false);
      setFilePaths([]);
      setFilesRunning(false);
      setContentResult(EMPTY_CONTENT_RESULT);
      setContentsRunning(false);
      setContentError(null);
      filesCacheKeyRef.current = null;
      return;
    }
    // Re-opening with a different shortcut (⌘K vs ⌘P vs ⌘F) re-selects the tab.
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
    if (!open || !hasMessageSearch || !showsGroup("Messages")) {
      messageTokenRef.current += 1;
      setMessageHits([]);
      setMessagesRunning(false);
      setMessageError(null);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_MESSAGE_QUERY_LENGTH) {
      messageTokenRef.current += 1;
      setMessageHits([]);
      setMessagesRunning(false);
      setMessageError(null);
      return;
    }
    const token = ++messageTokenRef.current;
    setMessagesRunning(true);
    const handle = window.setTimeout(() => {
      const run = searchMessagesRef.current;
      if (!run) return;
      void run(trimmed, MAX_PER_GROUP)
        .then((hits) => {
          if (token !== messageTokenRef.current) return;
          setMessageHits(hits);
          setMessageError(null);
        })
        .catch((caught: unknown) => {
          // A backend failure rendered as an empty list reads as "no matches",
          // which is a lie in a search UI. Say it failed.
          if (token !== messageTokenRef.current) return;
          setMessageHits([]);
          setMessageError(caught instanceof Error ? caught.message : "Message search failed.");
        })
        .finally(() => {
          if (token === messageTokenRef.current) {
            setMessagesRunning(false);
          }
        });
    }, MESSAGE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, query, hasMessageSearch, showsGroup]);

  // Debounced `git grep`. Unlike the file list this can't be cached: every
  // query is a fresh subprocess, so the debounce is the only thing between a
  // fast typist and a queue of greps.
  useEffect(() => {
    if (!open || !searchContents || !showsGroup("Contents")) {
      contentTokenRef.current += 1;
      setContentResult(EMPTY_CONTENT_RESULT);
      setContentsRunning(false);
      setContentError(null);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_CONTENT_QUERY_LENGTH) {
      contentTokenRef.current += 1;
      setContentResult(EMPTY_CONTENT_RESULT);
      setContentsRunning(false);
      setContentError(null);
      return;
    }
    const token = ++contentTokenRef.current;
    setContentsRunning(true);
    const handle = window.setTimeout(() => {
      void searchContents(trimmed)
        .then((next) => {
          if (token !== contentTokenRef.current) return;
          setContentResult(next);
          setContentError(null);
        })
        .catch((caught: unknown) => {
          if (token !== contentTokenRef.current) return;
          setContentResult(EMPTY_CONTENT_RESULT);
          setContentError(caught instanceof Error ? caught.message : "Search failed.");
        })
        .finally(() => {
          if (token === contentTokenRef.current) {
            setContentsRunning(false);
          }
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, query, searchContents, showsGroup]);

  // Lazy file-list load — fires on the first non-empty keystroke, or right
  // away on the Files tab. Cached for the palette session keyed by source.
  useEffect(() => {
    if (!open || !fileSource || !loadFiles || !showsGroup("Files")) {
      filesTokenRef.current += 1;
      filesCacheKeyRef.current = null;
      setFilePaths([]);
      setFilesRunning(false);
      setFilesError(null);
      return;
    }
    const cacheKey = `${fileSource.kind}:${fileSource.id}`;
    if (filesCacheKeyRef.current === cacheKey) return;
    if (query.trim().length === 0 && !filesEagerly) {
      filesTokenRef.current += 1;
      filesCacheKeyRef.current = null;
      setFilePaths([]);
      setFilesRunning(false);
      setFilesError(null);
      return;
    }
    const token = ++filesTokenRef.current;
    filesCacheKeyRef.current = cacheKey;
    setFilesRunning(true);
    void loadFiles(fileSource)
      .then((paths) => {
        if (token !== filesTokenRef.current) return;
        setFilePaths(paths);
        setFilesError(null);
      })
      .catch((caught: unknown) => {
        if (token !== filesTokenRef.current) return;
        setFilePaths([]);
        setFilesError(caught instanceof Error ? caught.message : "File list failed to load.");
        // The cache key was claimed optimistically; drop it so the next
        // keystroke retries instead of pinning the failure for the session.
        filesCacheKeyRef.current = null;
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
  const flatRows = useMemo<PaletteRow[]>(() => {
    const perGroup =
      query.trim().length === 0 && visibleGroups.length > 1
        ? MAX_RECENT_PER_GROUP
        : MAX_PER_GROUP;
    const byGroup = new Map<PaletteGroup, PaletteHit[]>();
    for (const hit of localHits) {
      const list = byGroup.get(hit.item.group) ?? [];
      if (list.length < perGroup) {
        list.push(hit);
        byGroup.set(hit.item.group, list);
      }
    }

    const rows: PaletteRow[] = [];
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
      if (group === "Contents") {
        for (const file of contentResult.files) {
          rows.push({ kind: "content-file", file, group: "Contents" });
          for (let index = 0; index < file.matches.length; index += 1) {
            rows.push({ kind: "content-match", file, matchIndex: index, group: "Contents" });
          }
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
  }, [contentResult.files, fileHits, localHits, messageHits, query, visibleGroups]);

  // Every row commits the same way, whichever list it came from. Content rows
  // open their file: the file header and its match rows both land on the path,
  // matching what ⌘P file-open does.
  const activateRow = useCallback(
    (row: PaletteRow): void => {
      onClose();
      switch (row.kind) {
        case "hit":
          row.hit.item.run();
          return;
        case "message":
          row.hit.run();
          return;
        case "content-file":
        case "content-match":
          onFilePick?.(row.file.path);
          return;
        default: {
          const exhaustive: never = row;
          return exhaustive;
        }
      }
    },
    [onClose, onFilePick]
  );

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
      activateRow(row);
      return;
    }
    // Esc is handled by useDismissOnOutsideOrEscape at the document level,
    // so it works regardless of which element holds focus inside the palette.
  };

  const trimmedQuery = query.trim();
  const anyBackgroundLoading = messagesRunning || filesRunning || contentsRunning;
  // Content search answers from two characters, message search from three, so
  // the "still too short to have run" gate follows the active tab.
  const minQueryLength = scope === "contents" ? MIN_CONTENT_QUERY_LENGTH : MIN_MESSAGE_QUERY_LENGTH;
  const searchErrors = [messageError, filesError, contentError].filter(
    (message): message is string => message !== null
  );
  const showingEmptyState =
    flatRows.length === 0 &&
    !anyBackgroundLoading &&
    searchErrors.length === 0 &&
    (trimmedQuery.length === 0 || trimmedQuery.length >= minQueryLength);

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
            {(messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH) ||
            filesRunning ||
            contentsRunning
              ? "searching…"
              : totalCount > 0
                ? `${totalCount} found${contentResult.truncated ? " (truncated)" : ""}`
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
          {searchErrors.map((message) => (
            <li key={message} className="command-palette-empty" role="alert">
              <span className="command-palette-empty-mark" aria-hidden="true">!</span>
              <span className="command-palette-empty-text">{message}</span>
            </li>
          ))}
          {showingEmptyState ? (
            <li className="command-palette-empty" role="status">
              <span className="command-palette-empty-mark" aria-hidden="true">∅</span>
              <span className="command-palette-empty-text">
                {trimmedQuery.length > 0
                  ? "No matches — try shorter terms or another filter."
                  : (scope === "files" || scope === "contents") && !fileSource
                    ? "Open a chat or project to search its files."
                    : `Start typing to search ${scopeNoun(scope)}.`}
              </span>
            </li>
          ) : null}
          {flatRows.map((row, index) => {
            const groupHeader = row.group !== lastGroup;
            lastGroup = row.group;
            const isSelected = index === selectedIndex;
            return (
              <Fragment key={rowKey(row)}>
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
                  data-group={row.group}
                  data-content={
                    row.kind === "content-file"
                      ? "file"
                      : row.kind === "content-match"
                        ? "match"
                        : undefined
                  }
                  onMouseDown={(event) => {
                    event.preventDefault();
                    activateRow(row);
                  }}
                >
                  {row.kind === "content-match" ? (
                    <span className="command-palette-line" aria-hidden="true">
                      {row.file.matches[row.matchIndex]?.line}
                    </span>
                  ) : row.kind === "content-file" ? (
                    <FileTypeIcon name={basename(row.file.path)} />
                  ) : row.kind === "hit" && row.group === "Files" ? (
                    <FileTypeIcon name={row.hit.item.label} />
                  ) : (
                    <RowIcon
                      icon={
                        (row.kind === "hit" ? row.hit.item.icon : undefined) ?? GROUP_ICON[row.group]
                      }
                    />
                  )}
                  {row.kind === "hit" ? (
                    <span className="command-palette-result-body">
                      <PaletteHitRow hit={row.hit} />
                    </span>
                  ) : row.kind === "message" ? (
                    <span className="command-palette-result-body stacked">
                      <MessageHitRow hit={row.hit} />
                    </span>
                  ) : row.kind === "content-file" ? (
                    <span className="command-palette-result-body">
                      <span className="command-palette-result-label">
                        {basename(row.file.path)}
                      </span>
                      <span className="command-palette-result-subtitle">
                        {dirname(row.file.path)}
                      </span>
                    </span>
                  ) : (
                    <span className="command-palette-result-body">
                      <span className="command-palette-result-preview">
                        {row.file.matches[row.matchIndex]?.preview}
                      </span>
                    </span>
                  )}
                  {row.kind === "hit" && row.hit.item.meta ? (
                    <span className="command-palette-result-meta">
                      <HighlightedText text={row.hit.item.meta} ranges={row.hit.subtitleRanges} />
                    </span>
                  ) : null}
                  {row.kind === "content-file" ? (
                    <span className="command-palette-result-meta" aria-hidden="true">
                      {row.file.matches.length}
                    </span>
                  ) : null}
                </li>
              </Fragment>
            );
          })}
          {messagesRunning && trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH ? (
            <li className="command-palette-loading" role="status">
              <WorkingNest active size={12} />
              Searching messages…
            </li>
          ) : null}
          {filesRunning ? (
            <li className="command-palette-loading" role="status">
              <WorkingNest active size={12} />
              Loading files…
            </li>
          ) : null}
          {contentsRunning ? (
            <li className="command-palette-loading" role="status">
              <WorkingNest active size={12} />
              Searching file contents…
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

function rowKey(row: PaletteRow): string {
  switch (row.kind) {
    case "hit":
      return row.hit.item.id;
    case "message":
      return row.hit.id;
    case "content-file":
      return `content:${row.file.path}`;
    case "content-match":
      return `content:${row.file.path}:${row.matchIndex}`;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function scopeNoun(scope: PaletteScope): string {
  switch (scope) {
    case "all":
      return "agents, files, actions, and settings";
    case "agents":
      return "agents, projects, and messages";
    case "files":
      return "files in the active workspace";
    case "messages":
      return "messages across every agent";
    case "contents":
      return "text inside the project's files";
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

/** File rows get the same type-colored glyph the review file tree uses. */
function FileTypeIcon({ name }: { name: string }): JSX.Element {
  return (
    <span className="command-palette-icon command-palette-icon--file" aria-hidden="true">
      <FileIcon fileName={name} autoAssign editFileNameData={SPECIAL_FILE_ICONS} width={14} height={14} />
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
