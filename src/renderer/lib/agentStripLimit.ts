/** What an unmeasured strip shows. jsdom never lays the row out, and the first
 *  frame before a width arrives uses the same count the automatic dock shows
 *  near its 560px ceiling. */
const STRIP_UNMEASURED = 4;
/** One tab's budget before another one earns a slot: emblem, a short codename,
 *  and the gap between pills. The drag floor (360px) leaves about two of
 *  these once the roster control is paid for; the automatic ceiling leaves
 *  about four; a dock dragged out past roughly 800px leaves seven. */
const STRIP_SLOT_PX = 96;
const STRIP_MIN = 2;
const STRIP_MAX = 7;

/** How many tabs the strip draws for a measured content width. Zero means the
 *  row has not been laid out yet, so the caller keeps the unmeasured count. */
export function agentStripLimit(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return STRIP_UNMEASURED;
  const count = Math.floor(widthPx / STRIP_SLOT_PX);
  return Math.min(STRIP_MAX, Math.max(STRIP_MIN, count));
}
