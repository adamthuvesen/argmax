/**
 * How strongly the app background follows the active theme, from 1 (softest)
 * to 10 (pure black in dark mode and pure white in light mode). Level 7 is
 * the background palette Argmax ships.
 */
export type BackgroundIntensity = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const BACKGROUND_INTENSITY_MIN: BackgroundIntensity = 1;
export const BACKGROUND_INTENSITY_MAX: BackgroundIntensity = 10;
export const DEFAULT_BACKGROUND_INTENSITY: BackgroundIntensity = 7;
export const BACKGROUND_INTENSITY_STORAGE_KEY = "argmax.background.intensity";

/** Caption under the background intensity control, one per level. */
export const BACKGROUND_INTENSITY_HINTS: Readonly<Record<BackgroundIntensity, string>> = {
  1: "Softest background.",
  2: "Very soft.",
  3: "Soft.",
  4: "Quiet.",
  5: "A step under default.",
  6: "Just under default.",
  7: "The background Argmax ships.",
  8: "A step stronger.",
  9: "Strong.",
  10: "Pure black in dark mode, pure white in light mode."
};

export function toBackgroundIntensity(
  raw: string | number | null | undefined
): BackgroundIntensity | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= BACKGROUND_INTENSITY_MIN && raw <= BACKGROUND_INTENSITY_MAX
      ? (raw as BackgroundIntensity)
      : null;
  }
  if (typeof raw !== "string" || !/^(?:[1-9]|10)$/.test(raw)) return null;
  return Number(raw) as BackgroundIntensity;
}

export function readStoredBackgroundIntensity(): BackgroundIntensity {
  if (typeof window === "undefined") return DEFAULT_BACKGROUND_INTENSITY;
  return (
    toBackgroundIntensity(window.localStorage.getItem(BACKGROUND_INTENSITY_STORAGE_KEY)) ??
    DEFAULT_BACKGROUND_INTENSITY
  );
}

export function applyBackgroundIntensityToDocument(intensity: BackgroundIntensity): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-background-intensity", String(intensity));
}
