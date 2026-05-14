/**
 * Renderer-side paint timing marks. `markFirstPaint` fires from `<App />`'s
 * first `useLayoutEffect`; `markFirstContent` fires when `loadState` leaves
 * "loading" for the first time. The measure (`argmax:tti`) surfaces in
 * Settings → Diagnostics → Startup as "Renderer first-content" alongside
 * the main-process startup phases.
 *
 * Both marks are idempotent — duplicate calls (StrictMode double-mount,
 * loadState flipping back to "loading") are no-ops so the measure stays
 * pinned to the *first* content paint.
 */

import { logger } from "../../shared/logger.js";

export const FIRST_PAINT_MARK = "argmax:first-paint";
export const FIRST_CONTENT_MARK = "argmax:first-content";
export const TTI_MEASURE = "argmax:tti";

let paintMarked = false;
let contentMarked = false;
let measureMs: number | null = null;

function performanceApi(): Performance | undefined {
  return typeof performance !== "undefined" ? performance : undefined;
}

export function markFirstPaint(): void {
  if (paintMarked) return;
  const perf = performanceApi();
  if (!perf) return;
  perf.mark(FIRST_PAINT_MARK);
  paintMarked = true;
}

export function markFirstContent(): void {
  if (contentMarked) return;
  const perf = performanceApi();
  if (!perf) return;
  // Without a prior first-paint mark there's nothing to measure against —
  // bail rather than throwing inside `performance.measure`.
  if (!paintMarked) return;
  perf.mark(FIRST_CONTENT_MARK);
  contentMarked = true;
  perf.measure(TTI_MEASURE, FIRST_PAINT_MARK, FIRST_CONTENT_MARK);
  const entry = perf.getEntriesByName(TTI_MEASURE).at(-1);
  measureMs = entry ? Math.round(entry.duration * 100) / 100 : null;
  if (measureMs !== null) {
    logger.info("renderer.paint", "first-content", { ms: measureMs });
  }
}

export function readFirstContentMeasure(): number | null {
  return measureMs;
}

/** Test-only: reset between fixtures so state doesn't leak. */
export function resetPaintTimingsForTesting(): void {
  paintMarked = false;
  contentMarked = false;
  measureMs = null;
  const perf = performanceApi();
  if (perf) {
    try {
      perf.clearMarks(FIRST_PAINT_MARK);
      perf.clearMarks(FIRST_CONTENT_MARK);
      perf.clearMeasures(TTI_MEASURE);
    } catch {
      // jsdom occasionally lacks clearMarks under older versions; safe to ignore.
    }
  }
}
