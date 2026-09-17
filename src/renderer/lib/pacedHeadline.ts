import { useEffect, useRef, useState } from "react";

/** A wording holds this long before the next one may take its place. */
export const CLAUSE_DWELL_MS = 800;

/**
 * Paces a running group's headline. Two rules, both about what the reader can
 * follow rather than what the provider did:
 *
 * - **Wording changes on the kind of work, not on the count.** A turn reading
 *   six files re-words `summarizeToolGroup`'s headline six times ("read 2
 *   files", "read 3 files", …) and real turns land four of those calls in the
 *   same millisecond. The count is not news while the work is still going, so
 *   the line holds until the *kinds* present change — read → edit → command —
 *   and the final counts land when the group settles.
 * - **One wording per beat.** A change that arrives inside the dwell is queued,
 *   and only the newest wording is ever shown: a burst collapses to one change
 *   rather than one per member.
 *
 * Returns the wording to show and the one it replaced, so the view can fade in
 * the clause that actually changed instead of flashing the whole line.
 */
export function usePacedHeadline(
  headline: string,
  kindKey: string,
  running: boolean
): { shown: string; previous: string } {
  const [shown, setShown] = useState(headline);
  const shownRef = useRef(headline);
  const previousRef = useRef(headline);
  const shownAtRef = useRef(0);
  const shownKindRef = useRef(kindKey);
  const timerRef = useRef<number | null>(null);
  // The effect reads the newest wording at fire time rather than the one that
  // scheduled the timer, which is what drops the intermediates in a burst.
  const latestRef = useRef({ headline, kindKey });
  latestRef.current = { headline, kindKey };

  useEffect(() => {
    const commit = (): void => {
      const next = latestRef.current;
      previousRef.current = shownRef.current;
      shownRef.current = next.headline;
      shownKindRef.current = next.kindKey;
      shownAtRef.current = performance.now();
      setShown(next.headline);
    };

    // A settled group is the moment the counts are worth reading, so it commits
    // whatever the dwell would otherwise have held back.
    if (!running) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (headline !== shownRef.current) commit();
      return;
    }

    if (kindKey === shownKindRef.current) return;   // same work, new count: hold

    const remaining = Math.max(0, CLAUSE_DWELL_MS - (performance.now() - shownAtRef.current));
    if (remaining === 0) {
      commit();
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commit();
    }, remaining);
  }, [headline, kindKey, running]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return { shown, previous: previousRef.current };
}

/** The clauses of a headline, as `summarizeToolGroup` joins them. */
export function headlineClauses(headline: string): string[] {
  return headline.split(", ").filter(Boolean);
}
