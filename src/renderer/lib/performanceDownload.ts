import type { PerformanceCapture } from "../../shared/types.js";

export function savePerformanceCapture(
  capture: PerformanceCapture,
  setStatus: (status: string | null) => void
): void {
  if (capture.samples.length === 0) {
    setStatus("No performance samples to save yet.");
    return;
  }
  try {
    const blob = new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `argmax-performance-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setStatus(`Saved ${capture.samples.length} performance samples.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save performance capture.");
  }
}
