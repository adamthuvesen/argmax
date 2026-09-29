/**
 * How strongly the app background follows the active theme, a whole number
 * from 0 to 100. Dark mode runs from a lifted charcoal at 0 through the shipped
 * palette at 70 to pure black at 100; light mode runs from soft gray at 0
 * through warm paper at 10 to pure white at 100. The arithmetic lives in
 * styles/background-intensity.css.
 */
export type BackgroundIntensity = number;

export const BACKGROUND_INTENSITY_MIN = 0;
export const BACKGROUND_INTENSITY_MAX = 100;
export const DEFAULT_BACKGROUND_INTENSITY = 70;
export const BACKGROUND_INTENSITY_STORAGE_KEY = "argmax.background.level";
/** The former 1–10 scale. Level n carried over as n × 10, so its default 7 stays the default. */
const LEGACY_BACKGROUND_INTENSITY_STORAGE_KEY = "argmax.background.intensity";

/** Named stops offered in the command palette. */
export const BACKGROUND_INTENSITY_PRESETS: readonly BackgroundIntensity[] = [0, 25, 50, 70, 85, 100];

export function backgroundIntensityHint(intensity: BackgroundIntensity): string {
  if (intensity === DEFAULT_BACKGROUND_INTENSITY) return "Default.";
  if (intensity === BACKGROUND_INTENSITY_MIN) return "Lightest: light gray in dark mode, soft gray in light mode.";
  if (intensity === BACKGROUND_INTENSITY_MAX) return "Pure black in dark mode, pure white in light mode.";
  return intensity < DEFAULT_BACKGROUND_INTENSITY ? "Softer than default." : "Stronger than default.";
}

export function toBackgroundIntensity(
  raw: string | number | null | undefined
): BackgroundIntensity | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= BACKGROUND_INTENSITY_MIN && raw <= BACKGROUND_INTENSITY_MAX
      ? raw
      : null;
  }
  if (typeof raw !== "string" || !/^(?:100|[1-9]?\d)$/.test(raw)) return null;
  return Number(raw);
}

export function readStoredBackgroundIntensity(): BackgroundIntensity {
  if (typeof window === "undefined") return DEFAULT_BACKGROUND_INTENSITY;
  const stored = toBackgroundIntensity(window.localStorage.getItem(BACKGROUND_INTENSITY_STORAGE_KEY));
  if (stored !== null) return stored;
  const legacy = window.localStorage.getItem(LEGACY_BACKGROUND_INTENSITY_STORAGE_KEY);
  const legacyLevel = /^(?:[1-9]|10)$/.test(legacy ?? "") ? Number(legacy) : null;
  return legacyLevel === null ? DEFAULT_BACKGROUND_INTENSITY : legacyLevel * 10;
}

export function applyBackgroundIntensityToDocument(intensity: BackgroundIntensity): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-background-intensity", String(intensity));
  root.style.setProperty("--background-intensity", String(intensity));
}
