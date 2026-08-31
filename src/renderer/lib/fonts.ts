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

/**
 * Type size, 1 (smallest) to 10 (largest). Each level shifts the whole type
 * scale by one pixel: body text (`--text-base`) is `9 + level` px, so level 1
 * reads at 10px, the default 6 at the 15px Argmax ships, and 10 at 19px.
 */
export type FontSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const FONT_SIZE_MIN: FontSize = 1;
export const FONT_SIZE_MAX: FontSize = 10;

/** Body-text (`--text-base`) size at a level, for the settings caption. */
export function fontSizeBasePx(size: FontSize): number {
  return 9 + size;
}

export function toFontSize(raw: string | null | undefined): FontSize | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= FONT_SIZE_MIN && parsed <= FONT_SIZE_MAX
    ? (parsed as FontSize)
    : null;
}

const SYSTEM_MONO_FALLBACK = '"Lilex Nerd Font", ui-monospace, "SFMono-Regular", Consolas, monospace';

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: "lilex",
    label: "Lilex",
    hint: "Original Argmax mono. Nerd-Font-patched so terminal-style glyphs still render.",
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
    hint: "Vercel's modern UI sans, paired with Geist Mono for code. Clean, slightly geometric, neutral.",
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

export const DEFAULT_FONT_ID: FontFamilyId = "geist-sans";
export const FONT_STORAGE_KEY = "argmax.font.family";
export const DEFAULT_FONT_SIZE: FontSize = 6;
/** App-chrome size: sidebar, titlebar, settings, global overlays. */
export const FONT_SIZE_STORAGE_KEY = "argmax.font.scale";
/** Agent-window size: conversations, composers, and agent activity panes. */
export const CHAT_FONT_SIZE_STORAGE_KEY = "argmax.font.scale.chat";

/**
 * Keys the retired 1–5 scale wrote. They keep their own names because the two
 * scales share numerals: a stored "4" means one size on the old scale and
 * another on the new, so the value can only be trusted under the key that
 * matches its scale. Old level N maps to N + 3 (both scales step 1px, and the
 * old default 3 is the new default 6); the string ids predate even the 1–5
 * scale.
 */
const LEGACY_FONT_SIZE_STORAGE_KEY = "argmax.font.size";
const LEGACY_CHAT_FONT_SIZE_STORAGE_KEY = "argmax.font.size.chat";
const LEGACY_STRING_FONT_SIZES: Readonly<Record<string, FontSize>> = {
  small: 5,
  default: 6,
  large: 7
};

function readLegacyFontSize(key: string): FontSize | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
    return (parsed + 3) as FontSize;
  }
  return LEGACY_STRING_FONT_SIZES[raw] ?? null;
}

const ALL_FONT_IDS = new Set<string>(FONT_OPTIONS.map((option) => option.id));

export function readStoredFont(): FontFamilyId {
  if (typeof window === "undefined") return DEFAULT_FONT_ID;
  const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
  if (raw && ALL_FONT_IDS.has(raw)) {
    return raw as FontFamilyId;
  }
  return DEFAULT_FONT_ID;
}

export function readStoredFontSize(): FontSize {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  return (
    toFontSize(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)) ??
    readLegacyFontSize(LEGACY_FONT_SIZE_STORAGE_KEY) ??
    DEFAULT_FONT_SIZE
  );
}

/**
 * Agent windows carry their own size. Before the split there was a single
 * stored size, so an upgrade with no chat key inherits the app value and
 * nothing jumps.
 */
export function readStoredChatFontSize(): FontSize {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  return (
    toFontSize(window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY)) ??
    readLegacyFontSize(LEGACY_CHAT_FONT_SIZE_STORAGE_KEY) ??
    readStoredFontSize()
  );
}

export function applyFontToDocument(id: FontFamilyId): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font", id);
}

export function applyFontSizeToDocument(size: FontSize): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font-size", String(size));
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

export function resolveCssPxVariable(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw.endsWith("px")) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveTerminalFontSize(): number {
  return resolveCssPxVariable("--text-terminal", 13);
}

// Per-font CSS loaders. Lilex + system fonts (system-mono, menlo, monaco)
// need no JS-loaded assets; the rest pull in @fontsource bundles only when
// actually applied (ralph B6 — defers CSS-embedded font URLs from cold
// launch). Geist Sans is the default, so its bundle loads on cold launch;
// it pairs with Geist Mono, so both load together.
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
      import("@fontsource/geist-sans/latin-700.css"),
      import("@fontsource-variable/geist-mono/wght.css")
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
let codeFontLoad: Promise<unknown> | null = null;

/**
 * Load Geist Mono, which `--font-code` names in every theme regardless of the
 * picked font family. Without this, choosing any non-Geist font left every code
 * surface — tool rows, diffs, file names, the changed-files card — silently
 * rendering the ui-monospace fallback, because the bundle only shipped with the
 * two Geist choices. Runs once and is shared by every caller.
 */
async function loadCodeFontAssets(): Promise<void> {
  codeFontLoad ??= import("@fontsource-variable/geist-mono/wght.css").catch((error) => {
    // A transient chunk failure must not poison the cache — clear it so the
    // next appearance change retries.
    codeFontLoad = null;
    throw error;
  });
  await codeFontLoad;
}

export async function loadFontAssets(id: FontFamilyId): Promise<void> {
  void loadCodeFontAssets().catch(() => undefined);
  if (loadedFonts.has(id)) return;
  const loader = FONT_CSS_LOADERS[id];
  if (!loader) return;
  await loader();
  // Cache only after a successful load. Adding id to the set before awaiting
  // permanently poisoned the cache on a transient chunk-fetch failure — the
  // font never recovered without a full page reload (R-033).
  loadedFonts.add(id);
}
