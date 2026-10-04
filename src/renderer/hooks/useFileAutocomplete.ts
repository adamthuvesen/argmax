import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { ComposerField } from "../components/composerEditor/composerField.js";
import { chatReferenceLink } from "../lib/composerContext.js";
import { searchFilePaths } from "../lib/paletteSearch.js";
import { searchChatTitles, type ChatDirectoryEntry } from "../state/chatDirectory.js";

export type FileAutocompleteSource =
  | { kind: "workspace"; id: string }
  | { kind: "project"; id: string };

/**
 * One row of the `@` menu: a file or folder to mention, or a chat to attach as
 * a reference. A chat row's `path` is its session id, which keeps the key
 * every row needs unique without a second field.
 */
export type FileAutocompleteEntry =
  | { path: string; kind: "file" | "dir" }
  | {
      path: string;
      kind: "chat";
      title: string;
      projectName: string;
      /** The line of conversation that matched, for a content hit. */
      snippet?: string;
    };

/** Shortest query that looks for chats at all: `@a` should stay a file menu. */
const CHAT_QUERY_MIN_CHARS = 2;
/** Shortest query worth a conversation-text search, run off the keystroke. */
const CHAT_CONTENT_QUERY_MIN_CHARS = 3;
const CHAT_CONTENT_DEBOUNCE_MS = 200;
const CHAT_ROW_LIMIT = 5;

/**
 * Returns the trigger range when the caret sits inside an `@token` mention —
 * i.e. an `@` preceded by start-of-string or whitespace, with no whitespace
 * between the `@` and the caret. Returns null otherwise.
 *
 * Skips `foo@bar.com` correctly: the `@` is preceded by `o`, not whitespace.
 */
export function parseFileQuery(
  input: string,
  caret: number
): { triggerStart: number; query: string } | null {
  if (caret < 1) return null;
  const upto = input.slice(0, caret);
  let atIndex = -1;
  for (let i = upto.length - 1; i >= 0; i--) {
    const ch = upto[i];
    if (ch === "@") {
      atIndex = i;
      break;
    }
    if (/\s/.test(ch)) return null;
  }
  if (atIndex < 0) return null;
  if (atIndex > 0 && !/\s/.test(upto[atIndex - 1])) return null;
  return { triggerStart: atIndex, query: upto.slice(atIndex + 1) };
}

/**
 * Builds the combined entry list: every file from `paths`, plus every unique
 * directory prefix derived from those paths. Files come first in the natural
 * (already-sorted) order; folders follow in alphabetical order. Fuzzy ranking
 * downstream interleaves them by relevance once the user types a query.
 */
export function buildEntries(paths: string[]): FileAutocompleteEntry[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    let idx = path.indexOf("/");
    while (idx >= 0) {
      dirs.add(path.slice(0, idx));
      idx = path.indexOf("/", idx + 1);
    }
  }
  const fileEntries: FileAutocompleteEntry[] = paths.map((path) => ({ path, kind: "file" }));
  const dirEntries: FileAutocompleteEntry[] = Array.from(dirs)
    .sort()
    .map((path) => ({ path, kind: "dir" }));
  return [...fileEntries, ...dirEntries];
}

interface UseFileAutocompleteArgs {
  input: string;
  setInput: (value: string) => void;
  inputRef: RefObject<ComposerField | null>;
  source: FileAutocompleteSource | null;
  /** The chats the menu may offer. Omitted, the menu is files only. */
  chats?: readonly ChatDirectoryEntry[];
  /** The chat this prompt belongs to, never offered to itself. */
  ownSessionId?: string | null;
}

export interface FileAutocompleteState {
  popoverOpen: boolean;
  filteredEntries: FileAutocompleteEntry[];
  selectionIndex: number;
  setSelectionIndex: (index: number) => void;
  selectEntry: (entry: FileAutocompleteEntry) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  /** Report the caret whenever it moves. */
  onSelectionChange: (caret: number) => void;
}

const POPOVER_LIMIT = 50;
// Each source can contribute tens of thousands of paths plus derived folder
// entries. A pane can visit many projects over its lifetime, so bound the
// convenience cache and re-fetch an old source after it falls out.
const SOURCE_CACHE_LIMIT = 4;

function sourceKey(source: FileAutocompleteSource | null): string | null {
  if (!source) return null;
  return `${source.kind}:${source.id}`;
}

const NO_CHATS: readonly ChatDirectoryEntry[] = [];

export function useFileAutocomplete({
  input,
  setInput,
  inputRef,
  source,
  chats = NO_CHATS,
  ownSessionId = null
}: UseFileAutocompleteArgs): FileAutocompleteState {
  const [caret, setCaret] = useState(0);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const cacheRef = useRef<Map<string, FileAutocompleteEntry[]>>(new Map());
  const [entriesBySource, setEntriesBySource] = useState<Map<string, FileAutocompleteEntry[]>>(
    new Map()
  );
  const inflightRef = useRef(new Set<string>());

  const trigger = useMemo(() => parseFileQuery(input, caret), [input, caret]);
  const key = sourceKey(source);
  const activeKeyRef = useRef(key);
  activeKeyRef.current = key;

  // Lazy fetch: only load the file list once the user actually opens an `@`
  // mention. Cached by source key so re-opening the popover is instant; a
  // failed fetch clears the inflight marker so the next activation retries.
  //
  // The result is applied unconditionally — no cancellation on cleanup. `trigger`
  // and `source` are fresh objects on every keystroke and every parent re-render,
  // so a cancelling cleanup would discard the in-flight response while the
  // re-run bailed on the inflight marker, and the popover would never open. The
  // response is keyed, and `cacheRef` is a per-instance keyed superset, so a late
  // response is always safe to store.
  useEffect(() => {
    if (!trigger || !source || !key) return;
    const cache = cacheRef.current;
    const cached = cache.get(key);
    if (cached) {
      // Refresh insertion order so actively revisited sources stay cached.
      cache.delete(key);
      cache.set(key, cached);
      return;
    }
    if (inflightRef.current.has(key)) return;
    const api = window.argmax?.workspace;
    if (!api) return;
    inflightRef.current.add(key);
    void api
      .listFiles(source)
      .then((fetched) => {
        const paths = fetched.map((entry) => entry.path);
        const built = buildEntries(paths);
        cache.set(key, built);
        while (cache.size > SOURCE_CACHE_LIMIT) {
          let evicted = false;
          for (const candidate of cache.keys()) {
            if (candidate === activeKeyRef.current) continue;
            cache.delete(candidate);
            evicted = true;
            break;
          }
          if (!evicted) break;
        }
        setEntriesBySource(new Map(cache));
      })
      .catch(() => {
        // swallow — next activation retries via the cleared inflight marker
      })
      .finally(() => {
        inflightRef.current.delete(key);
      });
  }, [trigger, source, key]);

  const allEntries = key ? entriesBySource.get(key) ?? null : null;

  const fileEntries = useMemo(() => {
    if (!trigger || !allEntries) return [] as FileAutocompleteEntry[];
    if (!trigger.query) return allEntries.slice(0, POPOVER_LIMIT);
    // Fuzzy-rank by path string; map ranked paths back to typed entries. We
    // build a lookup so the rank stays O(n) instead of O(n²) on the relookup.
    const byPath = new Map<string, FileAutocompleteEntry>();
    for (const entry of allEntries) byPath.set(entry.path, entry);
    const rankedPaths = searchFilePaths(
      allEntries.map((entry) => entry.path),
      trigger.query,
      POPOVER_LIMIT
    );
    const out: FileAutocompleteEntry[] = [];
    for (const path of rankedPaths) {
      const entry = byPath.get(path);
      if (entry) out.push(entry);
    }
    return out;
  }, [trigger, allEntries]);

  // Chats named by title come straight from the directory. Chats named by
  // what was said in them come from the conversation search, a round trip, so
  // it waits for the typing to pause and answers only for the query it was
  // asked: a late reply to an old query is dropped.
  const chatQuery =
    trigger && trigger.query.length >= CHAT_QUERY_MIN_CHARS ? trigger.query.trim() : "";
  const [contentHits, setContentHits] = useState<{
    query: string;
    entries: FileAutocompleteEntry[];
  }>({ query: "", entries: [] });
  useEffect(() => {
    if (chatQuery.length < CHAT_CONTENT_QUERY_MIN_CHARS || chats.length === 0) return undefined;
    const search = window.argmax?.session?.search;
    if (!search) return undefined;
    let current = true;
    const timer = window.setTimeout(() => {
      void search({ query: chatQuery, limit: 12 }).then(
        (hits) => {
          if (!current) return;
          const byId = new Map(chats.map((chat) => [chat.sessionId, chat]));
          const seen = new Set<string>();
          const entries: FileAutocompleteEntry[] = [];
          for (const hit of hits) {
            const chat = byId.get(hit.sessionId);
            if (!chat || seen.has(chat.sessionId)) continue;
            seen.add(chat.sessionId);
            entries.push({
              kind: "chat",
              path: chat.sessionId,
              title: chat.title,
              projectName: chat.projectName,
              snippet: hit.snippet.replace(/<\/?b>/g, "")
            });
          }
          setContentHits({ query: chatQuery, entries });
        },
        () => undefined
      );
    }, CHAT_CONTENT_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [chatQuery, chats]);

  const chatEntries = useMemo(() => {
    if (!chatQuery) return [] as FileAutocompleteEntry[];
    const byTitle: FileAutocompleteEntry[] = searchChatTitles(chats, chatQuery, CHAT_ROW_LIMIT)
      .filter((chat) => chat.sessionId !== ownSessionId)
      .map((chat) => ({
        kind: "chat",
        path: chat.sessionId,
        title: chat.title,
        projectName: chat.projectName
      }));
    const taken = new Set(byTitle.map((entry) => entry.path));
    const byContent =
      contentHits.query === chatQuery
        ? contentHits.entries.filter((entry) => !taken.has(entry.path) && entry.path !== ownSessionId)
        : [];
    return [...byTitle, ...byContent].slice(0, CHAT_ROW_LIMIT);
  }, [chatQuery, chats, contentHits, ownSessionId]);

  const filteredEntries = useMemo(
    () => [...fileEntries, ...chatEntries],
    [fileEntries, chatEntries]
  );

  // Reset the dismissed flag when the trigger boundary moves — either
  // the user closed and reopened a fresh `@`, or the `@` left the document.
  useEffect(() => {
    if (dismissedAt === null) return;
    if (!trigger || trigger.triggerStart !== dismissedAt) {
      setDismissedAt(null);
    }
  }, [trigger, dismissedAt]);

  // Stay open whenever the @ token is active and we have a haystack — even if
  // the current query matches nothing. Closing on transient empty filter
  // results caused visible flicker as the user typed each character.
  const popoverOpen =
    trigger !== null &&
    ((allEntries !== null && allEntries.length > 0) || chatEntries.length > 0) &&
    (dismissedAt === null || dismissedAt !== trigger.triggerStart);

  useEffect(() => {
    if (selectionIndex >= filteredEntries.length) {
      setSelectionIndex(0);
    }
  }, [filteredEntries.length, selectionIndex]);

  const selectEntry = useCallback(
    (entry: FileAutocompleteEntry): void => {
      if (!trigger) return;
      const before = input.slice(0, trigger.triggerStart);
      const after = input.slice(caret);
      const suffix = entry.kind === "dir" ? "/" : "";
      // A chat is attached as its link, which the editor draws as a chip; a
      // file stays the `@path` the agent reads.
      const insertion =
        entry.kind === "chat"
          ? `${chatReferenceLink({ sessionId: entry.path, title: entry.title })} `
          : `@${entry.path}${suffix} `;
      const next = `${before}${insertion}${after}`;
      const nextCaret = before.length + insertion.length;
      setInput(next);
      setSelectionIndex(0);
      // After React paints, restore the caret to land after the trailing space.
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      });
    },
    [trigger, input, caret, setInput, inputRef]
  );

  const onSelectionChange = useCallback((nextCaret: number): void => {
    setCaret(nextCaret);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (!popoverOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(trigger?.triggerStart ?? null);
        setSelectionIndex(0);
        return;
      }
      // The popover stays open over a transient empty filter (e.g. "@xyz");
      // navigation / commit keys no-op rather than crashing on `% 0` or
      // selecting `undefined`.
      if (filteredEntries.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectionIndex((prev) => (prev + 1) % filteredEntries.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectionIndex((prev) => (prev - 1 + filteredEntries.length) % filteredEntries.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const choice = filteredEntries[selectionIndex];
        if (choice) {
          event.preventDefault();
          selectEntry(choice);
        }
      }
    },
    [popoverOpen, filteredEntries, selectionIndex, selectEntry, trigger]
  );

  return {
    popoverOpen,
    filteredEntries,
    selectionIndex,
    setSelectionIndex,
    selectEntry,
    onKeyDown,
    onSelectionChange
  };
}
