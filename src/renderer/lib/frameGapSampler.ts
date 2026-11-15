import { registerPerfSource } from "./perfRegistry.js";

/** One stretch the main thread was busy. Times are `performance.now()` milliseconds. */
export interface FrameGap {
  start: number;
  duration: number;
}

const TICK_MS = 100;
const STALL_THRESHOLD_MS = 50;
// Lateness this long is the machine sleeping or the window being throttled,
// not a stall of this thread.
const SUSPENSION_MS = 10_000;
const CAPACITY = 256;

interface SamplerEnvironment {
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  now: () => number;
  isInactive: () => boolean;
  onGap: (gap: FrameGap) => void;
}

export interface FrameGapSampler {
  /** Re-evaluates visibility and focus; call when either changes. */
  sync: () => void;
  gaps: () => FrameGap[];
  clear: () => void;
}

/**
 * Replaces the `longtask` observer, which WKWebView never fires. A 100 ms timer
 * measures how late it runs; lateness above 50 ms is a main-thread stall. A
 * timer, unlike a rAF loop, does not make WebKit render every frame of an idle
 * window. It pauses while the window is hidden or unfocused, where WebKit
 * throttles timers on purpose. The ring is two preallocated arrays, so a tick
 * without a stall allocates nothing.
 */
export function createFrameGapSampler(env: SamplerEnvironment): FrameGapSampler {
  const starts = new Float64Array(CAPACITY);
  const durations = new Float64Array(CAPACITY);
  let count = 0;
  let due = 0;
  let handle: number | null = null;

  const onTick = (): void => {
    const now = env.now();
    const lateness = now - due;
    if (lateness > STALL_THRESHOLD_MS && lateness < SUSPENSION_MS) {
      const slot = count % CAPACITY;
      starts[slot] = due;
      durations[slot] = lateness;
      count += 1;
      env.onGap({ start: due, duration: lateness });
    }
    due = now + TICK_MS;
    handle = env.schedule(onTick, TICK_MS);
  };

  return {
    sync() {
      if (env.isInactive()) {
        if (handle !== null) env.cancel(handle);
        handle = null;
      } else if (handle === null) {
        due = env.now() + TICK_MS;
        handle = env.schedule(onTick, TICK_MS);
      }
    },
    gaps() {
      const size = Math.min(count, CAPACITY);
      const first = count - size;
      const out: FrameGap[] = [];
      for (let index = 0; index < size; index += 1) {
        const slot = (first + index) % CAPACITY;
        out.push({ start: starts[slot], duration: durations[slot] });
      }
      return out;
    },
    clear() {
      count = 0;
    },
  };
}

export function startFrameGapSampler(): FrameGapSampler {
  const sampler = createFrameGapSampler({
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle),
    now: () => performance.now(),
    isInactive: () => document.hidden || !document.hasFocus(),
    onGap: ({ duration }) => {
      void window.argmax?.system?.reportRendererStall?.(duration).catch(() => {
        // Performance recording is optional and must never affect rendering.
      });
      if (duration > 500) {
        console.warn(`[argmax] renderer stalled: main thread busy for ${Math.round(duration)}ms`);
      }
    },
  });
  document.addEventListener("visibilitychange", sampler.sync);
  window.addEventListener("focus", sampler.sync);
  window.addEventListener("blur", sampler.sync);
  sampler.sync();
  registerPerfSource("frames", sampler.gaps, sampler.clear);
  return sampler;
}
