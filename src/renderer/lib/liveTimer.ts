// Singleton rAF-driven registry for live elapsed timers.
//
// React state-based ticks (setInterval + useState) cascade through every
// consumer on every tick. During heavy streaming the renderer's main thread is
// busy reconciling the chat, so a 100ms interval gets starved and the visible
// number jumps in multi-second steps. This registry sidesteps React: it owns a
// single requestAnimationFrame loop and writes textContent directly on the
// registered DOM node, so the number stays in sync with paint regardless of
// how busy React is.

type Entry = {
  node: HTMLElement;
  getMs: () => number;
  format: (ms: number) => string;
  last: string;
};

const entries = new Set<Entry>();
let rafId: number | null = null;

function tick(): void {
  for (const entry of entries) {
    const next = entry.format(entry.getMs());
    if (next !== entry.last) {
      entry.node.textContent = next;
      entry.last = next;
    }
  }
  rafId = entries.size > 0 ? requestAnimationFrame(tick) : null;
}

export function registerLiveTimer(
  node: HTMLElement,
  getMs: () => number,
  format: (ms: number) => string
): () => void {
  const initial = format(getMs());
  node.textContent = initial;
  const entry: Entry = { node, getMs, format, last: initial };
  entries.add(entry);
  if (rafId === null) {
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    entries.delete(entry);
    if (entries.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

// Test-only: forces a synchronous tick without waiting for rAF. Exported for
// vitest where the jsdom rAF polyfill timing is awkward.
export function __liveTimerTickForTest(): void {
  for (const entry of entries) {
    const next = entry.format(entry.getMs());
    if (next !== entry.last) {
      entry.node.textContent = next;
      entry.last = next;
    }
  }
}
