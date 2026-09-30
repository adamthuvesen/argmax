/**
 * How firmly borders and dividers separate surfaces, a whole number from 0 to
 * 100. 50 is the line color Argmax ships and the arithmetic in
 * styles/background-intensity.css mixes 0% there. Below it lines fade into the
 * page; above it they darken on paper and brighten on charcoal. It is
 * independent of background intensity, which at the white end leaves lines as
 * the only thing drawing panel edges.
 */
export type Contrast = number;

export const CONTRAST_MIN = 0;
export const CONTRAST_MAX = 100;
export const DEFAULT_CONTRAST = 50;
export const CONTRAST_STORAGE_KEY = "argmax.contrast.level";

/** Named stops offered in the command palette. */
export const CONTRAST_PRESETS: readonly Contrast[] = [0, 25, 50, 75, 100];

export function contrastHint(contrast: Contrast): string {
  if (contrast === DEFAULT_CONTRAST) return "Default.";
  if (contrast === CONTRAST_MIN) return "Faintest: borders nearly disappear into the surface.";
  if (contrast === CONTRAST_MAX) return "Firmest: borders read clearly against every surface.";
  return contrast < DEFAULT_CONTRAST ? "Softer than default." : "Firmer than default.";
}

export function toContrast(raw: string | number | null | undefined): Contrast | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= CONTRAST_MIN && raw <= CONTRAST_MAX ? raw : null;
  }
  if (typeof raw !== "string" || !/^(?:100|[1-9]?\d)$/.test(raw)) return null;
  return Number(raw);
}

export function readStoredContrast(): Contrast {
  if (typeof window === "undefined") return DEFAULT_CONTRAST;
  return toContrast(window.localStorage.getItem(CONTRAST_STORAGE_KEY)) ?? DEFAULT_CONTRAST;
}

export function applyContrastToDocument(contrast: Contrast): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-contrast", String(contrast));
  root.style.setProperty("--contrast", String(contrast));
}
