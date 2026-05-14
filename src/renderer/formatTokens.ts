/**
 * Compact token counts for the sidebar badge: "0", "0.7k", "12.3k", "3.2M".
 *
 * Sidebar shows input + output only (the intuitive "tokens used" number).
 * Cache reads/writes are aggregated separately and surfaced in the tooltip.
 *
 * "k" is the minimum unit for non-zero values — sub-thousand counts still
 * render as e.g. "0.7k" so the badge has a consistent shape. We floor at
 * "0.1k" so very small counts don't collapse to "0k", which would read as
 * "no usage" when usage actually occurred.
 *
 * Negative values are preserved with a leading minus rather than collapsed —
 * if an upstream sign bug ever ships, we want it visible, not hidden.
 */
export function formatTokens(value: number | null | undefined): string {
  const v = value ?? 0;
  if (!Number.isFinite(v) || v === 0) return "0";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs < 1_000_000) {
    if (abs < 100) return `${sign}0.1k`;
    return `${sign}${trim(abs / 1_000)}k`;
  }
  if (abs < 1_000_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  return `${sign}${trim(abs / 1_000_000_000)}B`;
}

function trim(scaled: number): string {
  // 1 decimal up to 99.9, then drop decimals (957k, not 957.0k).
  if (scaled >= 100) return String(Math.round(scaled));
  const rounded = Math.round(scaled * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}
