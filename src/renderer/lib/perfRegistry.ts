/**
 * The one object behind `window.__argmaxPerf`, the read-only handle that
 * automation (verify scripts, the debugger) uses to pull renderer timings.
 * Each timing module registers its own reader here at import time.
 */
export interface IpcChannelStats {
  channel: string;
  /** Samples in the ring the percentiles are taken from. */
  count: number;
  /** Invocations since launch. */
  totalRecorded: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface ArgmaxPerf {
  /** Per-channel renderer round-trip latency in ms, slowest p99 first. */
  ipc: () => IpcChannelStats[];
  /** Empties every source that registered a clear function. */
  clear: () => void;
  [source: string]: () => unknown;
}

declare global {
  interface Window {
    __argmaxPerf?: ArgmaxPerf;
  }
}

const clearers: Array<() => void> = [];

/** Adds a read-only snapshot function to `window.__argmaxPerf` under `name`. */
export function registerPerfSource(name: string, read: () => unknown, clear?: () => void): void {
  if (typeof window === "undefined") return;
  if (clear) clearers.push(clear);
  const sources = { ...window.__argmaxPerf, [name]: read };
  window.__argmaxPerf = Object.freeze({
    ...sources,
    clear: () => clearers.forEach((fn) => fn()),
  }) as ArgmaxPerf;
}
