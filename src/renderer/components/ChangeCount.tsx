import type { JSX } from "react";

export function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="change-count" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  );
}
