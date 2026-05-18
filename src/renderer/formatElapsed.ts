export function formatElapsed(ms: number): string {
  // Visible sentinel for invalid input. Empty string would collapse next to
  // its label (e.g. "Ran in ") and silently hide upstream timing bugs.
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 950) return `${Math.max(0, Math.round(ms / 100) * 100) / 1000}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}
