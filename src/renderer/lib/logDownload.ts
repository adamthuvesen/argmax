import type { LogEntry } from "../../shared/types.js";

export function saveLogsFile(entries: ReadonlyArray<LogEntry>, setStatus: (status: string | null) => void): void {
  if (entries.length === 0) {
    setStatus("No log entries to save.");
    return;
  }
  try {
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `argmax-logs-${stamp}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setStatus(`Saved ${entries.length} log entries.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save log file.");
  }
}
