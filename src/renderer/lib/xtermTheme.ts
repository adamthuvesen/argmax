/** Shared xterm themes for integrated terminal + MCP auth dialog.
 *
 * xterm draws to canvas/WebGL outside the CSS context, so we can't reuse
 * `var(--bg)` etc. Each theme is a literal object the renderer picks based
 * on the current resolved theme. Keep both palettes hue-locked to the app
 * tokens (yellow-leaning warm grays, sage/amber/rose accents).
 */

import { themeAppearance } from "./theme.js";

export const LIGHT_XTERM_THEME = {
  background: "#fbfbfa",
  foreground: "#1c1b18",
  cursor: "#1c1b18",
  cursorAccent: "#fbfbfa",
  selectionBackground: "rgba(90, 143, 114, 0.28)",
  selectionForeground: "#1c1b18",
  black: "#1c1b18",
  red: "#b85763",
  green: "#3d6a52",
  yellow: "#b08039",
  blue: "#406789",
  magenta: "#8a4577",
  cyan: "#3f7a85",
  white: "#5d594f",
  brightBlack: "#3a3833",
  brightRed: "#cc6873",
  brightGreen: "#5a8f72",
  brightYellow: "#c89653",
  brightBlue: "#5687a8",
  brightMagenta: "#a55c92",
  brightCyan: "#5b95a1",
  brightWhite: "#8a857b"
} as const;

export const DARK_XTERM_THEME = {
  background: "#0e0e0c",
  foreground: "#f4f2ec",
  cursor: "#f4f2ec",
  cursorAccent: "#0e0e0c",
  selectionBackground: "rgba(127, 180, 148, 0.32)",
  selectionForeground: "#f4f2ec",
  // ANSI 0-7: tuned for warm charcoal — lifted lightness, slightly reduced chroma.
  black: "#2a2a25",
  red: "#e08591",
  green: "#7fb494",
  yellow: "#d9a566",
  blue: "#8fb3d4",
  magenta: "#d090c0",
  cyan: "#86c0c9",
  white: "#dcd8cf",
  // ANSI 8-15 (bright variants) — pushed ~10pp brighter than the base 8.
  brightBlack: "#5d594f",
  brightRed: "#f0a3ad",
  brightGreen: "#9fc9af",
  brightYellow: "#e8be88",
  brightBlue: "#abc6e0",
  brightMagenta: "#dba8ce",
  brightCyan: "#a3d0d8",
  brightWhite: "#f4f2ec"
} as const;

export interface XtermThemeObject {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function getXtermTheme(resolved: "light" | "dark"): XtermThemeObject {
  return resolved === "dark" ? DARK_XTERM_THEME : LIGHT_XTERM_THEME;
}

/**
 * Convenience: read the current resolved theme from the document attribute set
 * by `lib/theme.ts`. xterm consumers reach for this on construction; the live
 * theme-switch path uses `term.options.theme = getXtermTheme(...)` directly.
 */
export function readActiveXtermTheme(): XtermThemeObject {
  if (typeof document === "undefined") return LIGHT_XTERM_THEME;
  const attr = document.documentElement.getAttribute("data-theme");
  return getXtermTheme(themeAppearance(attr));
}
