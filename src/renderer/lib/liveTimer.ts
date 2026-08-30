// Singleton rAF-driven registry for live elapsed timers.
//
// React state-based ticks (setInterval + useState) cascade through every
// consumer on every tick. During heavy streaming the renderer's main thread is
// busy reconciling the chat, so a 100ms interval gets starved and the visible
// number jumps in multi-second steps. This registry sidesteps React: it owns a
// single requestAnimationFrame loop and writes textContent directly on the
// registered DOM node, so the number stays in sync with paint regardless of
// how busy React is.
//
// Two things keep the loop from being a background power drain. Entries format
// to whole seconds, so scanning every frame does ~60x the work needed to keep
// the text right — the scan is gated to `FLUSH_INTERVAL_MS`. And a hidden
// document schedules nothing at all: a backgrounded window with a running turn
// would otherwise hold a frame callback open for as long as the turn lasts.

type Entry = {
  node: HTMLElement;
  getMs: () => number;
  format: (ms: number) => string;
  last: string;
};

/// Fine enough that a seconds-resolution label never looks stale, coarse
/// enough to cost a fraction of a per-frame scan.
const FLUSH_INTERVAL_MS = 100;

const entries = new Set<Entry>();
let rafId: number | null = null;
let lastFlushAt = Number.NEGATIVE_INFINITY;

function flush(): void {
  for (const entry of entries) {
    const next = entry.format(entry.getMs());
    if (next !== entry.last) {
      entry.node.textContent = next;
      entry.last = next;
    }
  }
}

function shouldRun(): boolean {
  return entries.size > 0 && !document.hidden;
}

function tick(timestamp: number): void {
  if (timestamp - lastFlushAt >= FLUSH_INTERVAL_MS) {
    lastFlushAt = timestamp;
    flush();
  }
  rafId = shouldRun() ? requestAnimationFrame(tick) : null;
}

function start(): void {
  if (rafId === null && shouldRun()) {
    rafId = requestAnimationFrame(tick);
  }
}

function stop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// Coming back to a hidden document leaves every label showing the time it had
// when the window went away, so catch up before scheduling again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stop();
    return;
  }
  lastFlushAt = Number.NEGATIVE_INFINITY;
  flush();
  start();
});

export function registerLiveTimer(
  node: HTMLElement,
  getMs: () => number,
  format: (ms: number) => string
): () => void {
  const initial = format(getMs());
  node.textContent = initial;
  const entry: Entry = { node, getMs, format, last: initial };
  entries.add(entry);
  start();
  return () => {
    entries.delete(entry);
    if (entries.size === 0) {
      stop();
    }
  };
}

// Test-only: forces a synchronous tick without waiting for rAF. Exported for
// vitest where the jsdom rAF polyfill timing is awkward.
export function __liveTimerTickForTest(): void {
  flush();
}
