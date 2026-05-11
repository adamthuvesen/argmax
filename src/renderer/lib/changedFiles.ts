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
  if (status === "??" || status.includes("A")) {
    return "Added";
  }
  if (status.includes("D")) {
    return "Deleted";
  }
  if (status.includes("R")) {
    return "Renamed";
  }
  if (status.includes("C")) {
    return "Copied";
  }
  return "Modified";
}
