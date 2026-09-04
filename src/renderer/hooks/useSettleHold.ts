import { useEffect, useState } from "react";

export type SettlePhase = "running" | "landing" | "done";

/**
 * Hold a running mark on screen for `ms` after the work ends, so it can play its
 * landing before the finished mark replaces it.
 *
 * Every surface that shows the working nest swaps it for something else the
 * instant work stops — a bullet, a status glyph. Without this the nest unmounts
 * on the same frame it would have started settling, which is why the settled
 * state was unreachable in the shipped app until now.
 *
 * The flip is caught **during render**, not in an effect. An effect runs after
 * the commit, so the finished mark would already have painted once and taken
 * the nest out of the tree with it; the nest that came back a moment later
 * would be a fresh instance that never saw `active` go true → false, and the
 * landing still would not play. Comparing against previous state during render
 * is React's own answer to this, and it re-renders before anything is shown.
 *
 * Only the running → finished edge holds. A mark that mounts already finished
 * (a reopened session, a restored transcript) goes straight to "done": a
 * landing means "this just happened", and firing it on a restore would say so
 * about work that finished yesterday.
 */
export function useSettleHold(active: boolean, ms: number): SettlePhase {
  const [landing, setLanding] = useState(false);
  const [wasActive, setWasActive] = useState(active);

  if (active !== wasActive) {
    setWasActive(active);
    // Finishing starts the landing; starting again cancels one in flight.
    setLanding(!active);
  }

  useEffect(() => {
    if (!landing) return;
    const id = window.setTimeout(() => setLanding(false), ms);
    return () => window.clearTimeout(id);
  }, [landing, ms]);

  if (active) return "running";
  return landing ? "landing" : "done";
}
