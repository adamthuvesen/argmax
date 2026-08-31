/**
 * The 1–5 scale behind the agent window's content width. 1 is the narrowest
 * step, 5 the widest, and 3 is what Argmax ships, leaving two steps of headroom
 * in each direction.
 *
 * Type sizes no longer ride this scale: they moved to the 1–10 slider in
 * `fonts.ts`, which owns its own levels and migration.
 *
 * Levels 2, 3 and 4 are the sizes the old three-way setting offered, which is
 * what the `LEGACY_*` map in `chatWidth.ts` migrates onto.
 */
export type ScaleLevel = 1 | 2 | 3 | 4 | 5;

export const SCALE_LEVELS: readonly ScaleLevel[] = [1, 2, 3, 4, 5];
export const DEFAULT_SCALE_LEVEL: ScaleLevel = 3;
export const SCALE_LEVEL_MIN: ScaleLevel = 1;
export const SCALE_LEVEL_MAX: ScaleLevel = 5;

/** Radio options for a `Segmented` control. The level is its own label. */
export const SCALE_LEVEL_CHOICES = SCALE_LEVELS.map((level) => ({
  value: String(level),
  label: String(level)
}));

export function isScaleLevel(value: unknown): value is ScaleLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Parse a stored/selected level. Returns `null` for anything off the scale. */
export function toScaleLevel(raw: string | number | null | undefined): ScaleLevel | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
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
