import {
  AArrowDown,
  AArrowUp,
  Check,
  Contrast,
  ListTree,
  Monitor,
  Moon,
  Palette,
  Sun,
  Type
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PaletteItem } from "./paletteSearch.js";
import { ACCENT_OPTIONS, type AccentId } from "./accent.js";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, fontSizeBasePx, type FontSize } from "./fonts.js";
import {
  INK_STRENGTH_HINTS,
  INK_STRENGTH_MAX,
  INK_STRENGTH_MIN,
  type InkStrength
} from "./inkStrength.js";
import { THEME_OPTIONS, type ThemeMode } from "./theme.js";
import { CHAT_VERBOSITY_HINTS, CHAT_VERBOSITY_LABELS, type ChatVerbosity } from "./uiPreferences.js";

/**
 * The settings a user flips often enough to deserve a palette row of their own.
 * Every value gets a one-shot row ("Dark theme", "Chat detail 3: Balanced") so
 * typing the value applies it; the two font sizes also get larger/smaller
 * steps that keep the palette open, since a size is tuned by eye, one notch at
 * a time. Values and callbacks mirror the Appearance and Conversation panels.
 */
export type SettingCommandsInput = {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  fontSize: FontSize;
  onFontSizeChange: (size: FontSize) => void;
  chatFontSize: FontSize;
  onChatFontSizeChange: (size: FontSize) => void;
  chatVerbosity: ChatVerbosity;
  onChatVerbosityChange: (verbosity: ChatVerbosity) => void;
  inkStrength: InkStrength;
  onInkStrengthChange: (strength: InkStrength) => void;
};

const THEME_ICON: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

const FONT_SIZE_LEVELS: FontSize[] = Array.from(
  { length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 },
  (_, index) => (FONT_SIZE_MIN + index) as FontSize
);

const CHAT_VERBOSITY_LEVELS: ChatVerbosity[] = [1, 2, 3, 4];

const INK_STRENGTH_LEVELS: InkStrength[] = Array.from(
  { length: INK_STRENGTH_MAX - INK_STRENGTH_MIN + 1 },
  (_, index) => (INK_STRENGTH_MIN + index) as InkStrength
);

/**
 * Rows for one 1–10 type-size slider: a step in each direction, then every
 * level. Both steps stay listed at the bounds as no-ops: the palette keeps
 * them open and tracks the selection by index, so a row that vanished on the
 * last press would hand the next Enter to whatever slid into its place.
 */
function fontSizeCommands(
  idPrefix: string,
  label: string,
  scope: string,
  current: FontSize,
  onChange: (size: FontSize) => void
): PaletteItem[] {
  const stepRow = (direction: "larger" | "smaller"): PaletteItem => {
    const next = direction === "larger" ? current + 1 : current - 1;
    const inRange = next >= FONT_SIZE_MIN && next <= FONT_SIZE_MAX;
    return {
      id: `${idPrefix}:${direction}`,
      label: `${label}: ${direction}`,
      subtitle: inRange
        ? `${scope} · now ${fontSizeBasePx(current)}px`
        : `${scope} · already the ${direction === "larger" ? "largest" : "smallest"} size`,
      group: "Settings",
      icon: direction === "larger" ? AArrowUp : AArrowDown,
      keepOpen: true,
      run: () => {
        if (inRange) onChange(next as FontSize);
      }
    };
  };
  const levels: PaletteItem[] = FONT_SIZE_LEVELS.map((level) => ({
    id: `${idPrefix}:${level}`,
    label: `${label} ${level}`,
    subtitle: `${scope} · ${fontSizeBasePx(level)}px body text`,
    group: "Settings",
    icon: level === current ? Check : Type,
    run: () => onChange(level)
  }));
  return [stepRow("larger"), stepRow("smaller"), ...levels];
}

/**
 * Rows for the ink slider, shaped like the type-size ones: a step each way
 * that keeps the palette open, then every level. Ink is tuned by eye against
 * whatever is on screen, so the steps matter more here than the level rows.
 */
function inkStrengthCommands(
  current: InkStrength,
  onChange: (strength: InkStrength) => void
): PaletteItem[] {
  const stepRow = (direction: "stronger" | "softer"): PaletteItem => {
    const next = direction === "stronger" ? current + 1 : current - 1;
    const inRange = next >= INK_STRENGTH_MIN && next <= INK_STRENGTH_MAX;
    return {
      id: `setting:ink-strength:${direction}`,
      label: `Ink strength: ${direction}`,
      subtitle: inRange
        ? `Text contrast · now level ${current}`
        : `Text contrast · already the ${direction === "stronger" ? "strongest" : "softest"} ink`,
      group: "Settings",
      icon: Contrast,
      keepOpen: true,
      run: () => {
        if (inRange) onChange(next as InkStrength);
      }
    };
  };
  const levels: PaletteItem[] = INK_STRENGTH_LEVELS.map((level) => ({
    id: `setting:ink-strength:${level}`,
    label: `Ink strength ${level}`,
    subtitle: `Text contrast · ${INK_STRENGTH_HINTS[level]}`,
    group: "Settings",
    icon: level === current ? Check : Contrast,
    run: () => onChange(level)
  }));
  return [stepRow("stronger"), stepRow("softer"), ...levels];
}

export function buildSettingCommands(input: SettingCommandsInput): PaletteItem[] {
  const themes: PaletteItem[] = THEME_OPTIONS.map((option) => ({
    id: `setting:theme:${option.id}`,
    label: `${option.label} theme`,
    subtitle: option.hint,
    group: "Settings",
    icon: option.id === input.themeMode ? Check : THEME_ICON[option.id],
    run: () => input.onThemeModeChange(option.id)
  }));

  const accents: PaletteItem[] = ACCENT_OPTIONS.map((option) => ({
    id: `setting:accent:${option.id}`,
    label: `${option.label} accent`,
    subtitle: "Accent color for selection, focus, and chrome",
    group: "Settings",
    icon: option.id === input.accentId ? Check : Palette,
    run: () => input.onAccentChange(option.id)
  }));

  const verbosity: PaletteItem[] = CHAT_VERBOSITY_LEVELS.map((level) => ({
    id: `setting:chat-verbosity:${level}`,
    label: `Chat detail ${level}: ${CHAT_VERBOSITY_LABELS[level]}`,
    // The panel calls this "Chat detail & verbosity"; the label carries one
    // word and the subtitle the other, so either finds the row.
    subtitle: `Verbosity ${level} of 4 · ${CHAT_VERBOSITY_HINTS[level]}`,
    group: "Settings",
    icon: level === input.chatVerbosity ? Check : ListTree,
    run: () => input.onChatVerbosityChange(level)
  }));

  return [
    ...themes,
    ...accents,
    ...verbosity,
    ...fontSizeCommands(
      "setting:font-size",
      "App font size",
      "Sidebar, titlebar, settings",
      input.fontSize,
      input.onFontSizeChange
    ),
    // The panel says "Agent window font size"; the label says chat, the
    // display name for a session, and the subtitle keeps the panel's words.
    ...fontSizeCommands(
      "setting:chat-font-size",
      "Chat font size",
      "Agent windows, composers, activity",
      input.chatFontSize,
      input.onChatFontSizeChange
    ),
    ...inkStrengthCommands(input.inkStrength, input.onInkStrengthChange)
  ];
}
