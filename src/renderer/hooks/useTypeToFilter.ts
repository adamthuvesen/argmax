import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import { searchFilePaths } from "../lib/paletteSearch.js";
import { scrollChildIntoNearest } from "../lib/scrollChildIntoNearest.js";
import { useRestoreFocus } from "./useRestoreFocus.js";

export interface TypeToFilter<T> {
  /** What the user has typed since the popover opened. Empty until they do. */
  query: string;
  /** `items` narrowed to `query`, best match first; all of them while empty. */
  matches: T[];
  /** Index into `matches` that Enter picks. `-1` when nothing matches. */
  activeIndex: number;
  /** Bind to the popover list, which takes focus on open so keys land here. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

function isTypedCharacter(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

function rankByLabel<T>(items: readonly T[], toLabel: (item: T) => string, query: string): T[] {
  const labels = items.map(toLabel);
  // Same matcher the command palette runs on file paths: typo-tolerant, ranked,
  // and strict about left boundaries, so "arg" finds `argmax` but not `revargs`.
  const ranked = searchFilePaths(labels, query, labels.length);
  const byLabel = new Map<string, T[]>();
  items.forEach((item, index) => {
    const label = labels[index] ?? "";
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(item);
    else byLabel.set(label, [item]);
  });
  // Items sharing a label rank together, at the best of their positions. The
  // haystack carries one string per row, so a recent duplicate and its catalog
  // twin both match the same label — dedupe the ranked labels before expanding
  // or every match would emit the whole bucket again.
  const seen = new Set<string>();
  const uniqueRanked: string[] = [];
  for (const label of ranked) {
    if (seen.has(label)) continue;
    seen.add(label);
    uniqueRanked.push(label);
  }
  return uniqueRanked.flatMap((label) => byLabel.get(label) ?? []);
}

/**
 * Type-to-filter for a popover list with no search box to aim at.
 *
 * An open picker holds focus, so plain characters narrow the list instead of
 * landing in whatever input was focused behind it. Arrow keys walk the matches
 * and Enter picks one. The caller renders `PickerFilterRow` for the query echo:
 * silently shrinking a list is the confusing version of this feature.
 *
 * Escape stays dismissal, not "clear the query". `useDismissOnOutsideOrEscape`
 * owns it on the document, and one key with one meaning beats a stack. Closing
 * resets the query, and focus returns to whatever held it before the popover.
 */
export function useTypeToFilter<T>({
  open,
  items,
  toLabel,
  listRef,
  initialIndex = 0,
  onPick
}: {
  open: boolean;
  items: readonly T[];
  toLabel: (item: T) => string;
  listRef: RefObject<HTMLElement | null>;
  initialIndex?: number;
  onPick: (item: T) => void;
}): TypeToFilter<T> {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(initialIndex >= 0 ? initialIndex : 0);

  // Kept in a ref so an inline `toLabel` can't invalidate the match memo on
  // every render of the popover's parent.
  const toLabelRef = useRef(toLabel);
  toLabelRef.current = toLabel;

  const initialIndexRef = useRef(initialIndex);
  initialIndexRef.current = initialIndex;

  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [...items];
    return rankByLabel(items, toLabelRef.current, trimmed);
  }, [items, query]);

  const clampedIndex = matches.length === 0 ? -1 : Math.min(Math.max(0, activeIndex), matches.length - 1);

  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const startingIndex = initialIndexRef.current >= 0 ? initialIndexRef.current : 0;
    setActiveIndex(startingIndex);
    // Take focus so typing filters the list rather than the input behind it.
    // preventScroll: WKWebView otherwise pans the session so the listbox sits
    // in the visual viewport, which lifts the composer off the bottom.
    listRef.current?.focus({ preventScroll: true });
  }, [listRef, open]);

  // Keep the row Enter would pick on screen while arrowing through a long list.
  // Scroll only this list — scrollIntoView also pans ancestor scrollers, and
  // a selected model below the fold is enough to jump a session composer.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const active = list?.querySelector('[data-active="true"]');
    if (list && active) scrollChildIntoNearest(list, active);
  }, [clampedIndex, listRef, open, query]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (matches.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const from = clampedIndex === -1 ? 0 : clampedIndex;
        setActiveIndex((from + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter") {
        const item = clampedIndex === -1 ? undefined : matches[clampedIndex];
        if (!item) return;
        event.preventDefault();
        onPick(item);
        return;
      }
      if (event.key === "Backspace") {
        if (!query) return;
        event.preventDefault();
        setQuery(query.slice(0, -1));
        setActiveIndex(0);
        return;
      }
      if (!isTypedCharacter(event)) return;
      // A bare space is a scroll key, not the start of a query; inside one it's
      // a real character, since names like "Claude Opus" contain it.
      if (event.key === " " && !query) return;
      event.preventDefault();
      setQuery(query + event.key);
      setActiveIndex(0);
    },
    [clampedIndex, matches, onPick, query]
  );

  return { query, matches, activeIndex: clampedIndex, onKeyDown };
}
