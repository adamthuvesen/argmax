export type FontHeaviness = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const FONT_HEAVINESS_MIN: FontHeaviness = 1;
export const FONT_HEAVINESS_MAX: FontHeaviness = 10;
export const DEFAULT_FONT_HEAVINESS: FontHeaviness = 5;
export const FONT_HEAVINESS_STORAGE_KEY = "argmax.font.heaviness";

export const FONT_HEAVINESS_HINTS: Readonly<Record<FontHeaviness, string>> = {
  1: "Lightest.",
  2: "Very light.",
  3: "Light.",
  4: "Just under default.",
  5: "The weights Argmax ships.",
  6: "A little heavier.",
  7: "Heavier.",
  8: "Strong.",
  9: "Very strong.",
  10: "Heaviest."
};

export function toFontHeaviness(raw: string | number | null | undefined): FontHeaviness | null {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= FONT_HEAVINESS_MIN && parsed <= FONT_HEAVINESS_MAX
    ? (parsed as FontHeaviness)
    : null;
}

export function readStoredFontHeaviness(): FontHeaviness {
  if (typeof window === "undefined") return DEFAULT_FONT_HEAVINESS;
  return (
    toFontHeaviness(window.localStorage.getItem(FONT_HEAVINESS_STORAGE_KEY)) ?? DEFAULT_FONT_HEAVINESS
  );
}

/** Shift every designed weight together, preserving hierarchy and theme differences. */
export function applyFontHeavinessToDocument(heaviness: FontHeaviness): void {
  document.documentElement.style.setProperty("--font-weight-offset", String((heaviness - DEFAULT_FONT_HEAVINESS) * 25));
}
