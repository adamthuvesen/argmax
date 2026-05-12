import type { ChangedFileSummary } from "../../shared/types.js";

export function summarizeChangedFiles(files: ChangedFileSummary[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  );
}

export function statusLabel(status: string): string {
  // Git porcelain v1 status is `XY` where X is the index change and Y is
  // the worktree change. Discriminate on the primary (X) column so combo
  // codes like `AD` ("added in index, deleted in worktree") aren't matched
  // by every alternative that happens to share a letter.
  if (status === "??") return "Added";
  const primary = status[0] ?? "";
  switch (primary) {
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case " ": {
      // Index unchanged; the worktree column decides.
      const worktree = status[1] ?? "";
      return worktree === "D" ? "Deleted" : "Modified";
    }
    default:
      return "Modified";
  }
}
