export type ParsedDiffLine = {
  kind: "addition" | "deletion" | "context";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

export type ParsedDiffBlock =
  | { kind: "hunk"; id: string; header: string; lines: ParsedDiffLine[] }
  | { kind: "omitted"; id: string; count: number };

export function parseUnifiedDiff(content: string): ParsedDiffBlock[] {
  const lines = content.split("\n");
  const blocks: ParsedDiffBlock[] = [];
  let index = 0;
  let previousOldEnd: number | null = null;
  let hunkIndex = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
    if (!match) {
      index += 1;
      continue;
    }

    const oldStart = Number(match[1]);
    let oldLineNumber = oldStart;
    let newLineNumber = Number(match[2]);
    if (previousOldEnd !== null) {
      const omittedCount = oldStart - previousOldEnd - 1;
      if (omittedCount > 0) {
        blocks.push({ kind: "omitted", id: `omitted-${hunkIndex}`, count: omittedCount });
      }
    }

    const hunkLines: ParsedDiffLine[] = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("diff --git ")) {
        break;
      }
      if (line.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }
      // Inside a hunk body (post-`@@`) every `+`/`-`-prefixed line is an
      // addition or deletion respectively. File-header lines like `+++ b/f`
      // and `--- a/f` appear before the first `@@` and never reach this
      // branch — the outer loop's `@@` filter handled them. Dropping the
      // `!startsWith("+++")` guard means addition content like `++ foo`
      // (which arrives as `+++ foo`) is no longer silently discarded.
      if (line.startsWith("+")) {
        hunkLines.push({
          kind: "addition",
          oldLineNumber: null,
          newLineNumber,
          content: line.slice(1)
        });
        newLineNumber += 1;
      } else if (line.startsWith("-")) {
        hunkLines.push({
          kind: "deletion",
          oldLineNumber,
          newLineNumber: null,
          content: line.slice(1)
        });
        oldLineNumber += 1;
      } else if (line.startsWith(" ")) {
        hunkLines.push({
          kind: "context",
          oldLineNumber,
          newLineNumber,
          content: line.slice(1)
        });
        oldLineNumber += 1;
        newLineNumber += 1;
      }
      index += 1;
    }

    blocks.push({ kind: "hunk", id: `hunk-${hunkIndex}`, header, lines: hunkLines });
    previousOldEnd = oldLineNumber - 1;
    hunkIndex += 1;
  }

  return blocks;
}

export interface DiffLinePair {
  old: ParsedDiffLine | null;
  new: ParsedDiffLine | null;
}

/**
 * Pair unified-diff lines for side-by-side rendering. Algorithm:
 * - Context lines emit one pair with both columns set.
 * - Consecutive deletions buffer; subsequent additions consume deletions in
 *   order so an edit-pair renders on the same row.
 * - When the buffer flushes (context line or end of hunk) unpaired deletions
 *   emit as old-only rows.
 */
export function pairDiffLines(lines: ParsedDiffLine[]): DiffLinePair[] {
  const pairs: DiffLinePair[] = [];
  const pendingDeletions: ParsedDiffLine[] = [];
  let additionCursor = 0;

  const flushDeletions = (): void => {
    for (let i = additionCursor; i < pendingDeletions.length; i += 1) {
      pairs.push({ old: pendingDeletions[i], new: null });
    }
    pendingDeletions.length = 0;
    additionCursor = 0;
  };

  for (const line of lines) {
    if (line.kind === "context") {
      flushDeletions();
      pairs.push({ old: line, new: line });
      continue;
    }
    if (line.kind === "deletion") {
      pendingDeletions.push(line);
      continue;
    }
    if (additionCursor < pendingDeletions.length) {
      pairs.push({ old: pendingDeletions[additionCursor], new: line });
      additionCursor += 1;
    } else {
      pairs.push({ old: null, new: line });
    }
  }
  flushDeletions();
  return pairs;
}
