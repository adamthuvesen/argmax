import type { JSX } from "react";
import { useAnimatedNumber } from "../hooks/useAnimatedNumber.js";

export function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  // The ticking digits are presentational: the label always names the live
  // totals so assistive tech (and tests) never read a mid-flight value.
  const shownAdditions = useAnimatedNumber(additions);
  const shownDeletions = useAnimatedNumber(deletions);
  const additionsLabel = additions === 1 ? "addition" : "additions";
  const deletionsLabel = deletions === 1 ? "deletion" : "deletions";
  return (
    <span className="change-count" aria-label={`${additions} ${additionsLabel}, ${deletions} ${deletionsLabel}`}>
      <span className="additions">+{shownAdditions}</span>
      <span className="deletions">-{shownDeletions}</span>
    </span>
  );
}
