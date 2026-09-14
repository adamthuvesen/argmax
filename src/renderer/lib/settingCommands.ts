import {
  FONT_HEAVINESS_HINTS,
  FONT_HEAVINESS_MIN,
  FONT_HEAVINESS_MAX,
  type FontHeaviness
} from "./fontHeaviness.js";
import {
  AArrowDown,
  AArrowUp,
  Bell,
  BellOff,
  Check,
  Contrast,
  Columns2,
  Files,
  ListTree,
  Monitor,
  MoonStar,
  Moon,
  Palette,
  PanelLeft,
  PanelRight,
  Sun,
  Type,
  Zap,
  ZapOff
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PaletteItem } from "./paletteSearch.js";
import { ACCENT_OPTIONS, type AccentId } from "./accent.js";
import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  fontSizeBasePx,
  type FontFamilyId,
  type FontSize
} from "./fonts.js";
import {
  INK_STRENGTH_HINTS,
  INK_STRENGTH_MAX,
  INK_STRENGTH_MIN,
  type InkStrength
} from "./inkStrength.js";
import {
  BACKGROUND_INTENSITY_HINTS,
  BACKGROUND_INTENSITY_MAX,
  BACKGROUND_INTENSITY_MIN,
  type BackgroundIntensity
} from "./backgroundIntensity.js";
import { THEME_OPTIONS, type ThemeMode } from "./theme.js";
import { CHAT_WIDTH_HINTS, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX, type ChatWidth } from "./chatWidth.js";
import type { ReviewPanelSide } from "./reviewPanelSide.js";
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
  chatWidth: ChatWidth;
  onChatWidthChange: (width: ChatWidth) => void;
  reviewPanelSide: ReviewPanelSide;
  onReviewPanelSideChange: (side: ReviewPanelSide) => void;
  fontFamily: FontFamilyId;
  onFontFamilyChange: (font: FontFamilyId) => void;
  fontHeaviness: FontHeaviness;
  onFontHeavinessChange: (heaviness: FontHeaviness) => void;
  inkStrength: InkStrength;
  onInkStrengthChange: (strength: InkStrength) => void;
  backgroundIntensity: BackgroundIntensity;
  onBackgroundIntensityChange: (intensity: BackgroundIntensity) => void;
  desktopNotificationsEnabled: boolean;
  onDesktopNotificationsEnabledChange: (enabled: boolean) => void;
  keepAwakeEnabled: boolean;
  onKeepAwakeEnabledChange: (enabled: boolean) => void;
  fastModeEnabled: boolean;
  onFastModeEnabledChange: (enabled: boolean) => void;
  turnChangesExpanded: boolean;
  onTurnChangesExpandedChange: (expanded: boolean) => void;
  contextIndicatorEnabled: boolean;
  onContextIndicatorEnabledChange: (enabled: boolean) => void;
};

const THEME_ICON: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

const FONT_SIZE_LEVELS: FontSize[] = Array.from(
  { length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 },
  (_, index) => (FONT_SIZE_MIN + index) as FontSize
);

const CHAT_VERBOSITY_LEVELS: ChatVerbosity[] = [1, 2, 3, 4];

const CHAT_WIDTH_LEVELS: ChatWidth[] = Array.from(
  { length: CHAT_WIDTH_MAX - CHAT_WIDTH_MIN + 1 },
  (_, index) => (CHAT_WIDTH_MIN + index) as ChatWidth
);

const FONT_HEAVINESS_LEVELS: FontHeaviness[] = Array.from(
  { length: FONT_HEAVINESS_MAX - FONT_HEAVINESS_MIN + 1 },
  (_, index) => (FONT_HEAVINESS_MIN + index) as FontHeaviness
);

const INK_STRENGTH_LEVELS: InkStrength[] = Array.from(
  { length: INK_STRENGTH_MAX - INK_STRENGTH_MIN + 1 },
  (_, index) => (INK_STRENGTH_MIN + index) as InkStrength
);

const BACKGROUND_INTENSITY_LEVELS: BackgroundIntensity[] = Array.from(
  { length: BACKGROUND_INTENSITY_MAX - BACKGROUND_INTENSITY_MIN + 1 },
  (_, index) => (BACKGROUND_INTENSITY_MIN + index) as BackgroundIntensity
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
      group: "Actions",
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
    group: "Actions",
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
      group: "Actions",
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
    group: "Actions",
    icon: level === current ? Check : Contrast,
    run: () => onChange(level)
  }));
  return [stepRow("stronger"), stepRow("softer"), ...levels];
}

function fontHeavinessCommands(
  current: FontHeaviness,
  onChange: (strength: FontHeaviness) => void
): PaletteItem[] {
  const stepRow = (direction: "heavier" | "lighter"): PaletteItem => {
    const next = direction === "heavier" ? current + 1 : current - 1;
    const inRange = next >= FONT_HEAVINESS_MIN && next <= FONT_HEAVINESS_MAX;
    return {
      id: `setting:font-heaviness:${direction}`,
      label: `Font heaviness: ${direction}`,
      subtitle: inRange
        ? `Font weight · now level ${current}`
        : `Font weight · already the ${direction === "heavier" ? "heaviest" : "lightest"} weight`,
      group: "Actions",
      icon: Type,
      keepOpen: true,
      run: () => {
        if (inRange) onChange(next as FontHeaviness);
      }
    };
  };
  const levels: PaletteItem[] = FONT_HEAVINESS_LEVELS.map((level) => ({
    id: `setting:font-heaviness:${level}`,
    label: `Font heaviness ${level}`,
    subtitle: `Font weight · ${FONT_HEAVINESS_HINTS[level]}`,
    group: "Actions",
    icon: level === current ? Check : Type,
    run: () => onChange(level)
  }));
  return [stepRow("heavier"), stepRow("lighter"), ...levels];
}

function backgroundIntensityCommands(
  current: BackgroundIntensity,
  onChange: (intensity: BackgroundIntensity) => void
): PaletteItem[] {
  const stepRow = (direction: "stronger" | "softer"): PaletteItem => {
    const next = direction === "stronger" ? current + 1 : current - 1;
    const inRange = next >= BACKGROUND_INTENSITY_MIN && next <= BACKGROUND_INTENSITY_MAX;
    return {
      id: `setting:background-intensity:${direction}`,
      label: `Background intensity: ${direction}`,
      subtitle: inRange
        ? `Page color · now level ${current}`
        : `Page color · already the ${direction === "stronger" ? "strongest" : "softest"} background`,
      group: "Actions",
      icon: Contrast,
      keepOpen: true,
      run: () => {
        if (inRange) onChange(next as BackgroundIntensity);
      }
    };
  };
  const levels: PaletteItem[] = BACKGROUND_INTENSITY_LEVELS.map((level) => ({
    id: `setting:background-intensity:${level}`,
    label: `Background intensity ${level}`,
    subtitle: `Page color · ${BACKGROUND_INTENSITY_HINTS[level]}`,
    group: "Actions",
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
    group: "Actions",
    icon: option.id === input.themeMode ? Check : THEME_ICON[option.id],
    run: () => input.onThemeModeChange(option.id)
  }));

  const accents: PaletteItem[] = ACCENT_OPTIONS.map((option) => ({
    id: `setting:accent:${option.id}`,
    label: `${option.label} accent`,
    subtitle: "Accent color for selection, focus, and chrome",
    group: "Actions",
    icon: option.id === input.accentId ? Check : Palette,
    run: () => input.onAccentChange(option.id)
  }));

  const verbosity: PaletteItem[] = CHAT_VERBOSITY_LEVELS.map((level) => ({
    id: `setting:chat-verbosity:${level}`,
    label: `Chat detail ${level}: ${CHAT_VERBOSITY_LABELS[level]}`,
    // The panel calls this "Chat detail & verbosity"; the label carries one
    // word and the subtitle the other, so either finds the row.
    subtitle: `Verbosity ${level} of 4 · ${CHAT_VERBOSITY_HINTS[level]}`,
    group: "Actions",
    icon: level === input.chatVerbosity ? Check : ListTree,
    run: () => input.onChatVerbosityChange(level)
  }));

  const fonts: PaletteItem[] = FONT_OPTIONS.map((option) => ({
    id: `setting:font-family:${option.id}`,
    label: `Font family: ${option.label}`,
    subtitle: `Interface and code · ${option.hint}`,
    group: "Actions",
    icon: option.id === input.fontFamily ? Check : Type,
    run: () => input.onFontFamilyChange(option.id)
  }));

  const reviewPanelSides: PaletteItem[] = (["left", "right"] as const).map((side) => ({
    id: `setting:files-panel-side:${side}`,
    label: `Files panel: ${side}`,
    subtitle: side === "left"
      ? "Changes and files dock to the left of the conversation"
      : "Changes and files dock to the right of the conversation",
    group: "Actions",
    icon: side === input.reviewPanelSide ? Check : side === "left" ? PanelLeft : PanelRight,
    run: () => input.onReviewPanelSideChange(side)
  }));

  const toggleCommands: PaletteItem[] = [
    {
      id: `setting:notifications:${input.desktopNotificationsEnabled ? "disable" : "enable"}`,
      label: `${input.desktopNotificationsEnabled ? "Disable" : "Enable"} desktop notifications`,
      subtitle: "Show a desktop notice when an agent finishes or fails in the background",
      group: "Actions",
      icon: input.desktopNotificationsEnabled ? BellOff : Bell,
      run: () => input.onDesktopNotificationsEnabledChange(!input.desktopNotificationsEnabled)
    },
    {
      id: `setting:keep-awake:${input.keepAwakeEnabled ? "disable" : "enable"}`,
      label: `${input.keepAwakeEnabled ? "Disable" : "Enable"} keep computer awake`,
      subtitle: "Prevent the Mac from sleeping while any chat has a working agent",
      group: "Actions",
      icon: input.keepAwakeEnabled ? Moon : MoonStar,
      run: () => input.onKeepAwakeEnabledChange(!input.keepAwakeEnabled)
    },
    {
      id: `setting:fast-mode:${input.fastModeEnabled ? "disable" : "enable"}`,
      label: `${input.fastModeEnabled ? "Disable" : "Enable"} fast mode`,
      subtitle: "Request faster responses for supported models, with increased usage",
      group: "Actions",
      icon: input.fastModeEnabled ? ZapOff : Zap,
      run: () => input.onFastModeEnabledChange(!input.fastModeEnabled)
    },
    {
      id: `setting:changed-files:${input.turnChangesExpanded ? "collapse" : "expand"}`,
      label: `${input.turnChangesExpanded ? "Collapse" : "Expand"} changed files`,
      subtitle: "Show or hide the file list under each finished turn",
      group: "Actions",
      icon: Files,
      run: () => input.onTurnChangesExpandedChange(!input.turnChangesExpanded)
    },
    {
      id: `setting:context-indicator:${input.contextIndicatorEnabled ? "hide" : "show"}`,
      label: `${input.contextIndicatorEnabled ? "Hide" : "Show"} context indicator`,
      subtitle: "Show or hide context-window usage beside the model in active chats",
      group: "Actions",
      icon: input.contextIndicatorEnabled ? Moon : MoonStar,
      run: () => input.onContextIndicatorEnabledChange(!input.contextIndicatorEnabled)
    }
  ];

  return [
    ...themes,
    ...accents,
    ...verbosity,
    ...fonts,
    ...reviewPanelSides,
    ...CHAT_WIDTH_LEVELS.map((level): PaletteItem => ({
      id: `setting:chat-width:${level}`,
      label: `Chat width ${level}`,
      subtitle: `Agent window content width · ${CHAT_WIDTH_HINTS[level]}`,
      group: "Actions",
      icon: level === input.chatWidth ? Check : Columns2,
      run: () => input.onChatWidthChange(level)
    })),
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
    ...fontHeavinessCommands(input.fontHeaviness, input.onFontHeavinessChange),
    ...inkStrengthCommands(input.inkStrength, input.onInkStrengthChange),
    ...backgroundIntensityCommands(
      input.backgroundIntensity,
      input.onBackgroundIntensityChange
    ),
    ...toggleCommands
  ];
}
