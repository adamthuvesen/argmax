export type ParsedDiffLine = {
  kind: "addition" | "deletion" | "context";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

export type ParsedDiffBlock =
  | { kind: "hunk"; id: string; header: string; lines: ParsedDiffLine[] }
  | { kind: "omitted"; id: string; count: number }
  | { kind: "truncated"; id: string; droppedBytes: number };

/** Marker `cap_diff` appends in src-tauri/src/review/git_review.rs. Keep in sync. */
const TRUNCATION_MARKER = /^\[diff truncated at \d+ bytes; dropped (\d+) bytes\]$/m;

/**
 * Context ladder behind "expand unmodified lines". The starting rung is git's
 * own default (3 lines, requested as `null` so an untouched diff stays exactly
 * what it was), then a screenful, then the whole file. The last rung must stay
 * at or under `MAX_DIFF_CONTEXT_LINES` in src-tauri/src/ipc/validation.rs,
 * which rejects anything larger.
 */
export const DIFF_CONTEXT_STEPS: readonly number[] = [25, 100_000];

/** The next rung above `current`, or null when the whole file is already shown. */
export function nextDiffContext(current: number | null): number | null {
  return DIFF_CONTEXT_STEPS.find((step) => current === null || step > current) ?? null;
}

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
      // A new file starts a new line-number axis. Carrying the previous file's
      // end across the boundary would invent a gap out of two unrelated line
      // numbers, and that number is now a clickable claim.
      if (header.startsWith("diff --git ")) {
        previousOldEnd = null;
      }
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

  // A capped diff loses whole trailing hunks, and every line the parser skipped
  // is invisible by construction. Emit the loss as a block so the surface can
  // say so instead of rendering a confidently incomplete diff.
  const truncation = TRUNCATION_MARKER.exec(content);
  if (truncation) {
    blocks.push({
      kind: "truncated",
      id: "truncated",
      droppedBytes: Number(truncation[1])
    });
  }

  return blocks;
}
