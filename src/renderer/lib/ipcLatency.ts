import { noteIpcCall } from "./interactionTimings.js";
import { registerPerfSource, type IpcChannelStats } from "./perfRegistry.js";

/** Samples kept per channel. Percentiles describe only the most recent calls. */
export const RING_CAPACITY = 100;

interface Ring {
  samples: Float64Array;
  cursor: number;
  len: number;
  total: number;
}

const rings = new Map<string, Ring>();

export function recordIpcLatency(channel: string, ms: number): void {
  let ring = rings.get(channel);
  if (!ring) {
    ring = { samples: new Float64Array(RING_CAPACITY), cursor: 0, len: 0, total: 0 };
    rings.set(channel, ring);
  }
  ring.samples[ring.cursor] = ms;
  ring.cursor = (ring.cursor + 1) % RING_CAPACITY;
  if (ring.len < RING_CAPACITY) ring.len += 1;
  ring.total += 1;
}

/** Nearest-rank percentile of an ascending-sorted window. */
function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.round((sorted.length - 1) * p)] ?? 0;
}

/** Every channel called so far, slowest p99 first. Sorts copies, so call it on read, never per call. */
export function ipcLatencySnapshot(): IpcChannelStats[] {
  const stats: IpcChannelStats[] = [];
  for (const [channel, ring] of rings) {
    const sorted = ring.samples.slice(0, ring.len).sort();
    stats.push({
      channel,
      count: ring.len,
      totalRecorded: ring.total,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    });
  }
  return stats.sort((left, right) => right.p99 - left.p99);
}

const STALL_CHANNEL = "system:renderer-stall";

/**
 * Times a request/response call from invoke to settle, serialization and async
 * handler time included. A rejection counts: the user waited for it too. The
 * caller gets the original promise back.
 */
export function timeIpcCall<T>(channel: string, call: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  // Reporting a stall must not look like work an interaction waits on.
  const settleInteraction = channel === STALL_CHANNEL ? null : noteIpcCall();
  const promise = call();
  const done = (): void => {
    recordIpcLatency(channel, performance.now() - startedAt);
    settleInteraction?.();
  };
  promise.then(done, done);
  return promise;
}

/** Forget every sample. */
export function resetIpcLatency(): void {
  rings.clear();
}

registerPerfSource("ipc", ipcLatencySnapshot, resetIpcLatency);
