import type { JSX } from "react";
import { ACCENT_OPTIONS, type AccentId } from "../../lib/accent.js";
import {
  CHAT_WIDTH_HINTS,
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  type ChatWidth
} from "../../lib/chatWidth.js";
import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  fontSizeBasePx,
  toFontSize,
  type FontFamilyId,
  type FontSize
} from "../../lib/fonts.js";
import { toScaleLevel } from "../../lib/scaleLevel.js";
import type { ReviewPanelSide } from "../../lib/reviewPanelSide.js";
import { THEME_OPTIONS, type ThemeMode } from "../../lib/theme.js";
import { isUserBubbleTint, type UserBubbleTint } from "../../lib/userBubbleTint.js";
import {
  AccentPicker,
  FontFamilyPicker,
  SegmentedControl,
  SettingGroup,
  SettingRow,
  Slider,
  ThemePicker,
  Toggle
} from "./settingsPrimitives.js";

export function AppearanceSettings({
  fontFamily,
  onFontFamilyChange,
  themeMode,
  onThemeModeChange,
  accentId,
  onAccentChange,
  userBubbleTint,
  onUserBubbleTintChange,
  sidebarPriorityVisible,
  onSidebarPriorityVisibleChange,
  workspaceCardVisible,
  onWorkspaceCardVisibleChange,
  pixelFieldEnabled,
  onPixelFieldEnabledChange,
  chatWidth,
  onChatWidthChange,
  reviewPanelSide,
  onReviewPanelSideChange,
  fontSize,
  onFontSizeChange,
  chatFontSize,
  onChatFontSizeChange
}: {
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
  fontSize: FontSize;
  onFontSizeChange: (size: FontSize) => void;
  chatFontSize: FontSize;
  onChatFontSizeChange: (size: FontSize) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  userBubbleTint: UserBubbleTint;
  onUserBubbleTintChange: (tint: UserBubbleTint) => void;
  sidebarPriorityVisible: boolean;
  onSidebarPriorityVisibleChange: (v: boolean) => void;
  workspaceCardVisible: boolean;
  onWorkspaceCardVisibleChange: (v: boolean) => void;
  pixelFieldEnabled: boolean;
  onPixelFieldEnabledChange: (v: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidthChange: (width: ChatWidth) => void;
  reviewPanelSide: ReviewPanelSide;
  onReviewPanelSideChange: (side: ReviewPanelSide) => void;
}): JSX.Element {
  // Chat width rides a 1–5 slider: 1 narrowest, 3 default, 5 widest.
  const pickChatWidth = (raw: number, apply: (width: ChatWidth) => void): void => {
    const width = toScaleLevel(raw);
    if (width) apply(width);
  };
  // Font sizes ride a 1–10 slider: each level is 1px of body text, 8px at 1
  // through 17px at 10, with the shipped 13px default at 6.
  const pickFontSize = (raw: number, apply: (size: FontSize) => void): void => {
    const size = toFontSize(String(raw));
    if (size) apply(size);
  };
  const fontStack = FONT_OPTIONS.find((option) => option.id === fontFamily)?.stack;

  return (
    <>
      <SettingGroup id="settings-theme" label="Theme">
        <SettingRow
          label="Theme"
          description={THEME_OPTIONS.find((option) => option.id === themeMode)?.hint}
          control={<ThemePicker value={themeMode} onChange={onThemeModeChange} />}
        />
        <SettingRow
          label="Accent"
          description={ACCENT_OPTIONS.find((option) => option.id === accentId)?.hint}
          control={<AccentPicker value={accentId} onChange={onAccentChange} />}
        />
        <SettingRow
          label="Your message bubbles"
          description="Fill your own messages with the accent, or a quiet gray. The agent's replies stay unfilled either way."
          control={
            <SegmentedControl
              ariaLabel="Your message bubbles"
              name="user-bubble-tint"
              value={userBubbleTint}
              onChange={(v) => {
                if (isUserBubbleTint(v)) onUserBubbleTintChange(v);
              }}
              options={[
                { value: "accent", label: "Accent" },
                { value: "neutral", label: "Neutral" }
              ]}
            />
          }
        />
      </SettingGroup>

      <SettingGroup id="settings-typography" label="Typography">
        <SettingRow
          label="Font family"
          description="Interface and code."
          htmlFor="settings-font-family"
          control={
            <FontFamilyPicker
              inputId="settings-font-family"
              value={fontFamily}
              onChange={onFontFamilyChange}
            />
          }
        />
        {/* The one preview worth keeping: a name cannot show what a face looks like. */}
        <p className="settings-font-specimen" aria-hidden="true" style={{ fontFamily: fontStack }}>
          const argmax = (∑) ⇒ argmax · 0123456789
        </p>
        <SettingRow
          label="App font size"
          description={`Sidebar, titlebar, settings, and search. Body text at ${fontSizeBasePx(fontSize)}px.`}
          control={
            <Slider
              ariaLabel="App font size"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={fontSize}
              valueLabel={`${fontSizeBasePx(fontSize)}px`}
              onChange={(v) => pickFontSize(v, onFontSizeChange)}
            />
          }
        />
        <SettingRow
          label="Agent window font size"
          description={`Conversations, composers, and agent activity panes. Body text at ${fontSizeBasePx(chatFontSize)}px.`}
          control={
            <Slider
              ariaLabel="Agent window font size"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={chatFontSize}
              valueLabel={`${fontSizeBasePx(chatFontSize)}px`}
              onChange={(v) => pickFontSize(v, onChatFontSizeChange)}
            />
          }
        />
      </SettingGroup>

      <SettingGroup id="settings-layout" label="Layout">
        <SettingRow
          label="Chat width"
          description={`How wide a conversation runs before it stops growing. ${CHAT_WIDTH_HINTS[chatWidth]}`}
          control={
            <Slider
              ariaLabel="Chat width"
              min={CHAT_WIDTH_MIN}
              max={CHAT_WIDTH_MAX}
              value={chatWidth}
              valueLabel={String(chatWidth)}
              onChange={(v) => pickChatWidth(v, onChatWidthChange)}
            />
          }
        />
        <SettingRow
          label="Files panel side"
          description={
            reviewPanelSide === "left"
              ? "IDE order: changes and files on the left, the conversation on the right."
              : "Changes and files dock to the right of the conversation — how Argmax ships."
          }
          control={
            <SegmentedControl
              ariaLabel="Files panel side"
              name="review-panel-side"
              value={reviewPanelSide}
              onChange={(v) => onReviewPanelSideChange(v === "left" ? "left" : "right")}
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" }
              ]}
            />
          }
        />
        <SettingRow
          label="Priority section in sidebar"
          description="Float chats that need approval, are blocked, failed, or are ready for review to the top. Right-click a row to mark it done."
          control={
            <Toggle
              ariaLabel="Priority section in sidebar"
              checked={sidebarPriorityVisible}
              onChange={onSidebarPriorityVisibleChange}
            />
          }
        />
        <SettingRow
          label="Workspace card in agent view"
          description="Branch, changed lines, and one click into changes, files, terminal, commit, and the pull request. Needs a pane wide enough to sit beside the conversation."
          control={
            <Toggle
              ariaLabel="Workspace card in agent view"
              checked={workspaceCardVisible}
              onChange={onWorkspaceCardVisibleChange}
            />
          }
        />
        <SettingRow
          label="Pixel field in composer"
          description="As you type a new chat, ripple an animated pixel field across the input."
          control={
            <Toggle
              ariaLabel="Pixel field in composer"
              checked={pixelFieldEnabled}
              onChange={onPixelFieldEnabledChange}
            />
          }
        />
      </SettingGroup>
    </>
  );
}
