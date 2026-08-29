import type { JSX } from "react";
import { ACCENT_OPTIONS, type AccentId } from "../../lib/accent.js";
import { CHAT_WIDTH_HINTS, type ChatWidth } from "../../lib/chatWidth.js";
import { FONT_OPTIONS, FONT_SIZE_HINTS, type FontFamilyId, type FontSize } from "../../lib/fonts.js";
import { SCALE_LEVEL_CHOICES, toScaleLevel, type ScaleLevel } from "../../lib/scaleLevel.js";
import type { NewSessionMode } from "../../lib/newSessionMode.js";
import type { ReviewPanelSide } from "../../lib/reviewPanelSide.js";
import { THEME_OPTIONS, type ThemeMode } from "../../lib/theme.js";
import {
  AccentPicker,
  FontFamilyPicker,
  KeyValueList,
  SectionHeader,
  Segmented,
  ThemePicker,
  ToggleRow
} from "./settingsPrimitives.js";
import { Mascot } from "../Mascot.js";

export function GeneralSettings({
  fontFamily,
  onFontFamilyChange,
  themeMode,
  onThemeModeChange,
  accentId,
  onAccentChange,
  sidebarTokensVisible,
  onSidebarTokensVisibleChange,
  sidebarPriorityVisible,
  onSidebarPriorityVisibleChange,
  chatCostVisible,
  onChatCostVisibleChange,
  workspaceCardVisible,
  onWorkspaceCardVisibleChange,
  pixelFieldEnabled,
  onPixelFieldEnabledChange,
  chatWidth,
  onChatWidthChange,
  reviewPanelSide,
  onReviewPanelSideChange,
  newSessionMode,
  onNewSessionModeChange,
  randomSessionIconEnabled,
  onRandomSessionIconEnabledChange,
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
  sidebarTokensVisible: boolean;
  onSidebarTokensVisibleChange: (v: boolean) => void;
  sidebarPriorityVisible: boolean;
  onSidebarPriorityVisibleChange: (v: boolean) => void;
  chatCostVisible: boolean;
  onChatCostVisibleChange: (v: boolean) => void;
  workspaceCardVisible: boolean;
  onWorkspaceCardVisibleChange: (v: boolean) => void;
  pixelFieldEnabled: boolean;
  onPixelFieldEnabledChange: (v: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidthChange: (width: ChatWidth) => void;
  reviewPanelSide: ReviewPanelSide;
  onReviewPanelSideChange: (side: ReviewPanelSide) => void;
  newSessionMode: NewSessionMode;
  onNewSessionModeChange: (mode: NewSessionMode) => void;
  randomSessionIconEnabled: boolean;
  onRandomSessionIconEnabledChange: (v: boolean) => void;
}): JSX.Element {
  // The size controls share one 1–5 scale: 1 smallest, 3 what Argmax ships,
  // 5 largest. `Segmented` speaks strings, the settings speak levels.
  const pickLevel = (raw: string, apply: (level: ScaleLevel) => void): void => {
    const level = toScaleLevel(raw);
    if (level) apply(level);
  };

  return (
    <>
      <section className="settings-section" id="settings-local" aria-labelledby="settings-local-h">
        <SectionHeader
          id="settings-local-h"
          eyebrow="Identity"
          title="Local profile"
          description="Argmax runs locally on this machine — there is no cloud account."
        />
        <div className="settings-card">
          <div className="settings-account">
            <span className="settings-avatar" aria-hidden="true">
              <Mascot size={32} className="settings-avatar-mascot" label="Argmax mascot" />
            </span>
            <div className="settings-account-meta">
              <span className="settings-account-name">Argmax</span>
              <span className="settings-account-sub">Local · single user</span>
            </div>
            <span className="settings-status-chip" data-state="ok" aria-hidden="true">
              <span className="settings-status-chip-dot" />
              <span>online · on-device</span>
            </span>
          </div>
          <KeyValueList
            rows={[
              { dt: "Storage", dd: "SQLite (on this device)" },
              { dt: "Network", dd: "Provider calls only · no telemetry" }
            ]}
          />
        </div>
      </section>

      <section className="settings-section" id="settings-appearance" aria-labelledby="settings-appearance-h">
        <SectionHeader
          id="settings-appearance-h"
          eyebrow="Look & feel"
          title="Appearance"
          description="Theme and typography. Argmax is paper by day, warm charcoal by night — your call."
        />
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-theme-mode">Theme</label>
            <ThemePicker
              inputId="settings-theme-mode"
              value={themeMode}
              onChange={onThemeModeChange}
            />
          </div>
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              {THEME_OPTIONS.find((o) => o.id === themeMode)?.hint}
            </p>
          </div>

          <div className="settings-row">
            <label htmlFor="settings-accent-tint">Accent</label>
            <AccentPicker
              inputId="settings-accent-tint"
              value={accentId}
              onChange={onAccentChange}
            />
          </div>
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              {ACCENT_OPTIONS.find((o) => o.id === accentId)?.hint}
            </p>
          </div>

          <div className="settings-row">
            <label htmlFor="settings-font-family">Font family</label>
            <FontFamilyPicker
              inputId="settings-font-family"
              value={fontFamily}
              onChange={onFontFamilyChange}
            />
          </div>
          <div className="settings-card-sub">
            <p
              className="settings-font-caption"
              style={{ fontFamily: FONT_OPTIONS.find((o) => o.id === fontFamily)?.stack }}
            >
              {FONT_OPTIONS.find((o) => o.id === fontFamily)?.hint}
            </p>
            <p
              className="settings-font-preview"
              aria-hidden="true"
              style={{ fontFamily: FONT_OPTIONS.find((o) => o.id === fontFamily)?.stack }}
            >
              <span>const argmax = (∑) ⇒ argmax · 0123456789</span>
            </p>
          </div>

          <Segmented
            legend="App font size"
            hint="1 smallest · 3 default · 5 largest"
            name="font-size"
            value={String(fontSize)}
            onChange={(v) => pickLevel(v, onFontSizeChange)}
            options={SCALE_LEVEL_CHOICES}
          />
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              Sidebar, titlebar, settings, and search. {FONT_SIZE_HINTS[fontSize]}
            </p>
          </div>

          <Segmented
            legend="Agent window font size"
            hint="1 smallest · 3 default · 5 largest"
            name="chat-font-size"
            value={String(chatFontSize)}
            onChange={(v) => pickLevel(v, onChatFontSizeChange)}
            options={SCALE_LEVEL_CHOICES}
          />
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              Conversations, composers, and agent activity panes. {FONT_SIZE_HINTS[chatFontSize]}
            </p>
          </div>

          <ToggleRow
            label="Priority section in sidebar"
            description="Float sessions that need approval, are blocked, failed, or are ready for review to the top of the sidebar. Right-click a row to mark it done."
            checked={sidebarPriorityVisible}
            onChange={onSidebarPriorityVisibleChange}
          />

          <ToggleRow
            label="Show session tokens in sidebar"
            description="Display per-session token usage under each sidebar entry."
            checked={sidebarTokensVisible}
            onChange={onSidebarTokensVisibleChange}
          />

          <ToggleRow
            label="Show cost in agent chat"
            description="Display the session cost card beside the active conversation."
            checked={chatCostVisible}
            onChange={onChatCostVisibleChange}
          />

          <ToggleRow
            label="Workspace card in agent view"
            description="A summary of the session's worktree in the top-right of the agent view: branch, changed lines, and one click into changes, files, terminal, commit, and the pull request. It yields to the review and debug panels, and needs a pane wide enough to sit beside the conversation."
            checked={workspaceCardVisible}
            onChange={onWorkspaceCardVisibleChange}
          />

          <ToggleRow
            label="Pixel field in composer"
            description="As you type a new session, ripple an animated pixel field across the input."
            checked={pixelFieldEnabled}
            onChange={onPixelFieldEnabledChange}
          />

          <Segmented
            legend="Chat width"
            hint="1 narrowest · 3 default · 5 widest"
            name="chat-width"
            value={String(chatWidth)}
            onChange={(v) => pickLevel(v, onChatWidthChange)}
            options={SCALE_LEVEL_CHOICES}
          />
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              How wide a conversation runs before it stops growing. {CHAT_WIDTH_HINTS[chatWidth]}
            </p>
          </div>

          <Segmented
            legend="Files panel side"
            name="review-panel-side"
            value={reviewPanelSide}
            onChange={(v) => onReviewPanelSideChange(v === "left" ? "left" : "right")}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" }
            ]}
          />
          <div className="settings-card-sub">
            <p className="settings-font-caption">
              {reviewPanelSide === "left"
                ? "IDE order: changes and files on the left, the conversation on the right."
                : "Changes and files dock to the right of the conversation — how Argmax ships."}
            </p>
          </div>

          <KeyValueList
            rows={[
              { dt: "Reduce motion", dd: "Follows OS setting" }
            ]}
          />
        </div>
      </section>

      <section className="settings-section" id="settings-defaults" aria-labelledby="settings-defaults-h">
        <SectionHeader
          id="settings-defaults-h"
          eyebrow="Launch"
          title="Launch defaults"
          description="Choose whether ⌘N opens a launcher inside the active grid or replaces it with a full new-session view."
        />
        <div className="settings-card">
          <Segmented
            legend="New session"
            name="new-session-mode"
            value={newSessionMode}
            onChange={(v) => onNewSessionModeChange(v as NewSessionMode)}
            options={[
              { value: "embedded", label: "Open in grid" },
              { value: "full", label: "Open full view" }
            ]}
          />
          <ToggleRow
            label="Random icon for new sessions"
            description="Give each new session a random icon and color."
            checked={randomSessionIconEnabled}
            onChange={onRandomSessionIconEnabledChange}
          />
          <KeyValueList
            rows={[
              { dt: "Worktree base", dd: "Configured per project" },
              { dt: "Setup & check commands", dd: "Configured per project" }
            ]}
          />
        </div>
      </section>
    </>
  );
}
