import type { JSX } from "react";

export function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  const additionsLabel = additions === 1 ? "addition" : "additions";
  const deletionsLabel = deletions === 1 ? "deletion" : "deletions";
  return (
    <span className="change-count" aria-label={`${additions} ${additionsLabel}, ${deletions} ${deletionsLabel}`}>
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  );
}
