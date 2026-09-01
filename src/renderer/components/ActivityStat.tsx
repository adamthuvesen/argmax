import type { JSX } from "react";
import type { ChangeCounts } from "../lib/fileChange.js";

/**
 * The `+29 −4` a chat activity line shows beside what it touched. Decorative:
 * the row or headline it sits in already carries the accessible label, and a
 * screen reader reading "plus twenty-nine" out of context helps nobody.
 *
 * Zero sides are dropped rather than rendered as `+0`, so a pure-addition edit
 * reads as one green number instead of a two-tone pair.
 */
export function ActivityStat({ counts }: { counts: ChangeCounts }): JSX.Element | null {
  if (counts.adds === 0 && counts.dels === 0) return null;
  return (
    <span className="activity-stat" aria-hidden="true">
      {counts.adds > 0 ? <span className="adds">+{counts.adds}</span> : null}
      {counts.dels > 0 ? <span className="dels">−{counts.dels}</span> : null}
      {counts.files > 1 ? <span className="files">· {counts.files} files</span> : null}
    </span>
  );
}
