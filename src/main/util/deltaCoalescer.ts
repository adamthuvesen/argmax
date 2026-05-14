import type { DashboardDelta } from "../../shared/types.js";

/**
 * Trailing-debounce wrapper that combines multiple `dashboard:delta` pushes
 * into a single IPC send no more often than once per 16 ms (60 fps).
 *
 * Provider session flushes can emit several deltas per second under load —
 * each one wakes the renderer, walks the snapshot merger, and forces a
 * React commit. Coalescing at the push boundary caps that to one commit
 * per frame and lets the renderer's mergeDashboardDelta de-dupe the
 * concatenated payload (ralph C7).
 */

const DEFAULT_INTERVAL_MS = 16;

export class DeltaCoalescer {
  private pending: DashboardDelta | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly send: (delta: DashboardDelta) => void,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  publish(delta: DashboardDelta): void {
    this.pending = this.pending ? mergeDeltas(this.pending, delta) : delta;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushNow(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Force an immediate flush — useful at shutdown so the last batch isn't
   * stranded in the timer.
   */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const flushed = this.pending;
    this.pending = null;
    if (flushed) this.send(flushed);
  }
}

export function mergeDeltas(a: DashboardDelta, b: DashboardDelta): DashboardDelta {
  const result: DashboardDelta = { ...a };
  for (const key of Object.keys(b) as Array<keyof DashboardDelta>) {
    const bv = b[key];
    if (bv === undefined) continue;
    const av = result[key];
    if (av === undefined) {
      // Renderer's mergeDashboardDelta consumes plain arrays — same shape.
      (result as Record<string, unknown>)[key] = bv;
    } else if (Array.isArray(av) && Array.isArray(bv)) {
      // Concat lets the renderer dedupe by id; later entries win. Cheap and
      // correct without rebuilding the dedup logic here.
      (result as Record<string, unknown>)[key] = [...av, ...bv];
    } else {
      (result as Record<string, unknown>)[key] = bv;
    }
  }
  return result;
}
