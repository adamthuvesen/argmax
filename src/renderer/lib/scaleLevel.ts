/**
 * The 1–5 scale behind every size setting: type sizes for app chrome and agent
 * windows, and the agent window's content width. 1 is the smallest step, 5 the
 * largest, and 3 is what Argmax ships. A fresh install looks the same as it
 * always did while leaving two steps of headroom in each direction.
 *
 * Levels 2, 3 and 4 are the sizes the old three-way settings offered, which is
 * what `LEGACY_*` maps in the modules below migrate onto.
 */
export type ScaleLevel = 1 | 2 | 3 | 4 | 5;

export const SCALE_LEVELS: readonly ScaleLevel[] = [1, 2, 3, 4, 5];
export const DEFAULT_SCALE_LEVEL: ScaleLevel = 3;

/** Radio options for a `Segmented` control. The level is its own label. */
export const SCALE_LEVEL_CHOICES = SCALE_LEVELS.map((level) => ({
  value: String(level),
  label: String(level)
}));

export function isScaleLevel(value: unknown): value is ScaleLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Parse a stored/selected level. Returns `null` for anything off the scale. */
export function toScaleLevel(raw: string | null | undefined): ScaleLevel | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return isScaleLevel(parsed) ? parsed : null;
}

/**
 * Read a level from `localStorage`, accepting the pre-scale ids a stored
 * setting may still hold. The next persist writes the level back, so the
 * legacy value converts on first run rather than lingering.
 */
export function readStoredScaleLevel(
  key: string,
  legacy: Readonly<Record<string, ScaleLevel>>
): ScaleLevel | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  return toScaleLevel(raw) ?? legacy[raw] ?? null;
}
