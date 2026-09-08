/**
 * How hard the app's text sits against the page, 1 (softest) to 10
 * (strongest). Level 7 is the ink Argmax ships, and the ladder in
 * `tokens.css` mixes 0% there, so the default is the shipped color itself.
 *
 * The travel is lopsided on purpose — six steps down, three up. Both themes
 * already run their ink close to the readable maximum (dark's emphasis sits
 * within 0.04 of paper-white in OKLCH lightness, and was held back there
 * deliberately), so there is far more room to pull ink toward the page than
 * to push it toward the extreme.
 */
export type InkStrength = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const INK_STRENGTH_MIN: InkStrength = 1;
export const INK_STRENGTH_MAX: InkStrength = 10;
export const DEFAULT_INK_STRENGTH: InkStrength = 7;
export const INK_STRENGTH_STORAGE_KEY = "argmax.ink.strength";

/** Caption under the ink control, one per level. */
export const INK_STRENGTH_HINTS: Readonly<Record<InkStrength, string>> = {
  1: "Faintest. Text sinks most of the way into the page.",
  2: "Very soft.",
  3: "Soft.",
  4: "Quiet.",
  5: "A step under default.",
  6: "Just under default.",
  7: "The ink Argmax ships.",
  8: "A step stronger.",
  9: "Strong.",
  10: "Strongest. Near-black on paper, near-white on charcoal."
};

export function toInkStrength(raw: string | number | null | undefined): InkStrength | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= INK_STRENGTH_MIN && parsed <= INK_STRENGTH_MAX
    ? (parsed as InkStrength)
    : null;
}

export function readStoredInkStrength(): InkStrength {
  if (typeof window === "undefined") return DEFAULT_INK_STRENGTH;
  return (
    toInkStrength(window.localStorage.getItem(INK_STRENGTH_STORAGE_KEY)) ?? DEFAULT_INK_STRENGTH
  );
}

/**
 * Unlike the type-size ladder, no container hosts its own ink — the whole app
 * reads one level off `<html>`.
 */
export function applyInkStrengthToDocument(strength: InkStrength): void {
  document.documentElement.setAttribute("data-ink-strength", String(strength));
}
