export type FontFamilyId =
  | "lilex"
  | "system-mono"
  | "menlo"
  | "monaco"
  | "jetbrains-mono"
  | "fira-code"
  | "geist-mono"
  | "ibm-plex-mono"
  | "inter"
  | "geist-sans"
  | "ibm-plex-sans"
  | "manrope";

export type FontOption = {
  id: FontFamilyId;
  label: string;
  hint: string;
  stack: string;
};

const SYSTEM_MONO_FALLBACK = '"Lilex Nerd Font", ui-monospace, "SFMono-Regular", Consolas, monospace';

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: "lilex",
    label: "Lilex",
    hint: "Default. Nerd-Font–patched mono with the icon set Argmax was designed around.",
    stack: `"Lilex Nerd Font", "Lilex Nerd Font Mono", ${SYSTEM_MONO_FALLBACK}`
  },
  {
    id: "system-mono",
    label: "System Mono",
    hint: "Your OS's default mono — SF Mono on macOS, Cascadia on Windows. Zero bundle, fully native.",
    stack: `ui-monospace, "SFMono-Regular", "SF Mono", "Cascadia Mono", "Segoe UI Mono", monospace`
  },
  {
    id: "menlo",
    label: "Menlo",
    hint: "macOS-bundled mono — clean grotesque sans with subtly humanist details.",
    stack: `Menlo, ui-monospace, Consolas, monospace`
  },
  {
    id: "monaco",
    label: "Monaco",
    hint: "The classic Mac coding font — distinctive curves on g, 0, 1. Unmistakable.",
    stack: `Monaco, Menlo, ui-monospace, Consolas, monospace`
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    hint: "The IDE-standard mono used in JetBrains products and a popular Cursor choice.",
    stack: `"JetBrains Mono Variable", "JetBrains Mono", ${SYSTEM_MONO_FALLBACK}`
  },
  {
    id: "fira-code",
    label: "Fira Code",
    hint: "Ligature-rich coding font; long a favorite in VS Code and Cursor.",
    stack: `"Fira Code Variable", "Fira Code", ${SYSTEM_MONO_FALLBACK}`
  },
  {
    id: "geist-mono",
    label: "Geist Mono",
    hint: "Vercel's modern mono; clean and rounded, used across v0 and similar AI tools.",
    stack: `"Geist Mono Variable", "Geist Mono", ${SYSTEM_MONO_FALLBACK}`
  },
  {
    id: "ibm-plex-mono",
    label: "IBM Plex Mono",
    hint: "Slightly bookish, pairs well with the paper-grain background.",
    stack: `"IBM Plex Mono", ${SYSTEM_MONO_FALLBACK}`
  },
  {
    id: "inter",
    label: "Inter",
    hint: "Proportional humanist sans — book-like, less editor-y. Code blocks stay mono.",
    stack: `"Inter Variable", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  },
  {
    id: "geist-sans",
    label: "Geist Sans",
    hint: "Vercel's modern UI sans — clean, slightly geometric, neutral. Code blocks stay mono.",
    stack: `"Geist Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  },
  {
    id: "ibm-plex-sans",
    label: "IBM Plex Sans",
    hint: "Warm humanist sans — slightly bookish, pairs well with the paper-grain background.",
    stack: `"IBM Plex Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  },
  {
    id: "manrope",
    label: "Manrope",
    hint: "Friendly humanist sans — slightly rounded, softer than Inter.",
    stack: `"Manrope Variable", Manrope, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  }
] as const;

export const DEFAULT_FONT_ID: FontFamilyId = "lilex";
export const FONT_STORAGE_KEY = "argmax.font.family";

const ALL_FONT_IDS = new Set<string>(FONT_OPTIONS.map((option) => option.id));

export function readStoredFont(): FontFamilyId {
  if (typeof window === "undefined") return DEFAULT_FONT_ID;
  const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
  if (raw && ALL_FONT_IDS.has(raw)) {
    return raw as FontFamilyId;
  }
  return DEFAULT_FONT_ID;
}

export function getFontOption(id: FontFamilyId): FontOption {
  return FONT_OPTIONS.find((option) => option.id === id) ?? FONT_OPTIONS[0];
}

export function applyFontToDocument(id: FontFamilyId): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font", id);
}

/**
 * xterm renders to canvas/WebGL outside the CSS context, so it can't consume
 * `var(--font-mono)` directly. Resolve the active mono stack to a literal
 * string so the terminal tracks the font picker like everything else.
 */
export function resolveMonoFontStack(): string {
  if (typeof document === "undefined") {
    return '"Lilex Nerd Font", "Lilex Nerd Font Mono", ui-monospace, monospace';
  }
  const computed = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return computed || '"Lilex Nerd Font", "Lilex Nerd Font Mono", ui-monospace, monospace';
}

// Per-font CSS loaders. Default Lilex + system fonts (system-mono, menlo,
// monaco) need no JS-loaded assets; the rest pull in @fontsource bundles
// only when the user actually picks them (ralph B6 — defers ~80 kB of
// CSS-embedded font URLs from cold launch).
const FONT_CSS_LOADERS: Partial<Record<FontFamilyId, () => Promise<unknown>>> = {
  "jetbrains-mono": () => import("@fontsource-variable/jetbrains-mono/wght.css"),
  "fira-code": () => import("@fontsource-variable/fira-code/wght.css"),
  "geist-mono": () => import("@fontsource-variable/geist-mono/wght.css"),
  "ibm-plex-mono": () =>
    Promise.all([
      import("@fontsource/ibm-plex-mono/latin-400.css"),
      import("@fontsource/ibm-plex-mono/latin-500.css"),
      import("@fontsource/ibm-plex-mono/latin-700.css")
    ]),
  inter: () => import("@fontsource-variable/inter/wght.css"),
  "geist-sans": () =>
    Promise.all([
      import("@fontsource/geist-sans/latin-400.css"),
      import("@fontsource/geist-sans/latin-500.css"),
      import("@fontsource/geist-sans/latin-700.css")
    ]),
  "ibm-plex-sans": () =>
    Promise.all([
      import("@fontsource/ibm-plex-sans/latin-400.css"),
      import("@fontsource/ibm-plex-sans/latin-500.css"),
      import("@fontsource/ibm-plex-sans/latin-700.css")
    ]),
  manrope: () => import("@fontsource-variable/manrope/wght.css")
};

const loadedFonts = new Set<FontFamilyId>();

export async function loadFontAssets(id: FontFamilyId): Promise<void> {
  if (loadedFonts.has(id)) return;
  loadedFonts.add(id);
  const loader = FONT_CSS_LOADERS[id];
  if (!loader) return;
  await loader();
}

/** Test-only: clear the loaded-font cache between fixtures. */
export function resetLoadedFontsForTesting(): void {
  loadedFonts.clear();
}
