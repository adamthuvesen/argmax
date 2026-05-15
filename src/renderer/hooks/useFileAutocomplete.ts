import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SyntheticEvent
} from "react";

import { searchFilePaths } from "../lib/paletteSearch.js";

export type FileAutocompleteSource =
  | { kind: "workspace"; id: string }
  | { kind: "project"; id: string };

export interface FileAutocompleteEntry {
  path: string;
  kind: "file" | "dir";
}

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
  inputRef: RefObject<HTMLTextAreaElement | null>;
  source: FileAutocompleteSource | null;
}

export interface FileAutocompleteState {
  popoverOpen: boolean;
  filteredEntries: FileAutocompleteEntry[];
  selectionIndex: number;
  setSelectionIndex: (index: number) => void;
  selectEntry: (entry: FileAutocompleteEntry) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSelectionChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
}

const POPOVER_LIMIT = 50;

function sourceKey(source: FileAutocompleteSource | null): string | null {
  if (!source) return null;
  return `${source.kind}:${source.id}`;
}

export function useFileAutocomplete({
  input,
  setInput,
  inputRef,
  source
}: UseFileAutocompleteArgs): FileAutocompleteState {
  const [caret, setCaret] = useState(0);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const cacheRef = useRef<Map<string, FileAutocompleteEntry[]>>(new Map());
  const [entriesBySource, setEntriesBySource] = useState<Map<string, FileAutocompleteEntry[]>>(
    new Map()
  );
  const inflightRef = useRef<string | null>(null);

  const trigger = useMemo(() => parseFileQuery(input, caret), [input, caret]);
  const key = sourceKey(source);

  // Lazy fetch: only load the file list once the user actually opens an `@`
  // mention. Cached by source key so re-opening the popover is instant; a
  // failed fetch clears the inflight marker so the next activation retries.
  useEffect(() => {
    if (!trigger || !source || !key) return;
    if (cacheRef.current.has(key)) return;
    if (inflightRef.current === key) return;
    const api = window.argmax?.workspace;
    if (!api) return;
    inflightRef.current = key;
    let cancelled = false;
    const fetcher =
      source.kind === "workspace" ? api.listFiles(source.id) : api.listFilesForProject(source.id);
    void fetcher
      .then((fetched) => {
        if (cancelled) return;
        const paths = fetched.map((entry) => entry.path);
        const built = buildEntries(paths);
        cacheRef.current.set(key, built);
        setEntriesBySource(new Map(cacheRef.current));
      })
      .catch(() => {
        if (cancelled) return;
        inflightRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [trigger, source, key]);

  const allEntries = key ? entriesBySource.get(key) ?? null : null;

  const filteredEntries = useMemo(() => {
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
    allEntries !== null &&
    allEntries.length > 0 &&
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
      const insertion = `@${entry.path}${suffix} `;
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

  const onSelectionChange = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>): void => {
      const target = event.currentTarget;
      setCaret(target.selectionStart ?? 0);
    },
    []
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
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
