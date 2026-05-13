/**
 * Per-channel IPC latency histogram. Each channel keeps a rolling window of
 * the most recent N samples; `readHistogram()` returns p50 / p99 / count for
 * every channel that has been sampled. Cheap (one push + one slice on the
 * hot path) and stays useful: the Diagnostics panel surfaces these values
 * so a runaway handler shows up without shell access.
 *
 * Usage from `ipc.ts`:
 *
 *   ipcMain.handle("foo:bar", withTimedValidation("foo:bar", schema, fn))
 *
 * `withValidation` itself stays untouched; the timed variant wraps it so
 * callers that don't pass a channel name get the original zero-overhead
 * behavior.
 */

import { performance } from "node:perf_hooks";

const WINDOW_SIZE = 100;
const samples = new Map<string, number[]>();

export interface ChannelStats {
  channel: string;
  count: number;
  /** Total samples ever recorded for the channel (not the window cap). */
  totalRecorded: number;
  p50: number;
  p99: number;
}

const totalRecorded = new Map<string, number>();

export function recordSample(channel: string, ms: number): void {
  let bucket = samples.get(channel);
  if (!bucket) {
    bucket = [];
    samples.set(channel, bucket);
  }
  bucket.push(ms);
  // Bounded window: oldest sample drops off so a long-running app doesn't
  // grow the array forever. Splice from the front rather than reallocating
  // — N stays at 100, so the cost is constant.
  if (bucket.length > WINDOW_SIZE) {
    bucket.splice(0, bucket.length - WINDOW_SIZE);
  }
  totalRecorded.set(channel, (totalRecorded.get(channel) ?? 0) + 1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[rank] ?? 0) * 100) / 100;
}

export function readHistogram(): ChannelStats[] {
  const result: ChannelStats[] = [];
  for (const [channel, window] of samples) {
    const sorted = [...window].sort((a, b) => a - b);
    result.push({
      channel,
      count: window.length,
      totalRecorded: totalRecorded.get(channel) ?? 0,
      p50: percentile(sorted, 50),
      p99: percentile(sorted, 99)
    });
  }
  return result.sort((a, b) => a.channel.localeCompare(b.channel));
}

export function resetHistogramForTesting(): void {
  samples.clear();
  totalRecorded.clear();
}

/**
 * Wrap an IPC handler with channel-aware timing. Use as:
 *
 *   ipcMain.handle("foo:bar", timed("foo:bar", withValidation(schema, fn)));
 *
 * The wrapper records `performance.now()` deltas on both success and
 * failure paths so a slow rejection still surfaces in the histogram.
 */
export function timed<TArgs extends readonly unknown[], TOut>(
  channel: string,
  handler: (event: unknown, ...args: TArgs) => TOut | Promise<TOut>
): (event: unknown, ...args: TArgs) => Promise<TOut> {
  return async (event, ...args) => {
    const start = performance.now();
    try {
      return await handler(event, ...args);
    } finally {
      recordSample(channel, performance.now() - start);
    }
  };
}
