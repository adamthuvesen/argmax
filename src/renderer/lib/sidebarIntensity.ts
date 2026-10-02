/** Independent side-panel colors, from softer tones to stronger theme colors. */
export type SidebarIntensity = number;

export const SIDEBAR_INTENSITY_MIN = 0;
export const SIDEBAR_INTENSITY_MAX = 100;
export const DEFAULT_SIDEBAR_INTENSITY = 70;
export const SIDEBAR_INTENSITY_STORAGE_KEY = "argmax.sidebar.level";
export const SIDEBAR_INTENSITY_PRESETS: readonly SidebarIntensity[] = [0, 25, 50, 70, 85, 100];

export function sidebarIntensityHint(intensity: SidebarIntensity): string {
  if (intensity === DEFAULT_SIDEBAR_INTENSITY) return "Default: darker in light mode, brighter in dark mode.";
  if (intensity === SIDEBAR_INTENSITY_MIN) return "Light gray in dark mode, soft gray in light mode.";
  if (intensity === SIDEBAR_INTENSITY_MAX) return "Deep near-black in dark mode, pure white in light mode.";
  return intensity < DEFAULT_SIDEBAR_INTENSITY ? "Softer than default." : "Stronger than default.";
}

export function toSidebarIntensity(raw: string | number | null | undefined): SidebarIntensity | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= SIDEBAR_INTENSITY_MIN && raw <= SIDEBAR_INTENSITY_MAX
      ? raw
      : null;
  }
  if (typeof raw !== "string" || !/^(?:100|[1-9]?\d)$/.test(raw)) return null;
  return Number(raw);
}

export function readStoredSidebarIntensity(): SidebarIntensity {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_INTENSITY;
  return toSidebarIntensity(window.localStorage.getItem(SIDEBAR_INTENSITY_STORAGE_KEY))
    ?? DEFAULT_SIDEBAR_INTENSITY;
}

export function applySidebarIntensityToDocument(intensity: SidebarIntensity): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-sidebar-intensity", String(intensity));
  root.style.setProperty("--sidebar-intensity", String(intensity));
}
