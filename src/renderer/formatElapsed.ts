// Stopwatch-style ticker for the turn header. Always whole seconds so the
// rAF-driven liveTimer only repaints once per second instead of jittering with
// fractional values that look stuck and then jump.
export function formatElapsedSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function formatThoughtLabel(live: boolean, durationMs?: number): string {
  if (live) return "Thinking";
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1_000) {
    return "Thought";
  }
  return `Thought ${formatElapsedSeconds(durationMs)}`;
}

export function thoughtDurationMs(createdAt: string, lastActivityAt: string): number | undefined {
  const start = Date.parse(createdAt);
  const end = Date.parse(lastActivityAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}
