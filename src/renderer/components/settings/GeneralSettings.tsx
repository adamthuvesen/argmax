import type { JSX } from "react";
import { ACCENT_OPTIONS, type AccentId } from "../../lib/accent.js";
import { FONT_OPTIONS, type FontFamilyId } from "../../lib/fonts.js";
import type { NewSessionMode } from "../../lib/newSessionMode.js";
import { THEME_OPTIONS, type ThemeMode } from "../../lib/theme.js";
import type { ThinkingStyle } from "../../lib/thinkingStyle.js";
import {
  AccentPicker,
  FontFamilyPicker,
  KeyValueList,
  SectionHeader,
  Segmented,
  ThemePicker,
  ToggleRow
} from "./settingsPrimitives.js";

export function GeneralSettings({
  fontFamily,
  onFontFamilyChange,
  themeMode,
  onThemeModeChange,
  accentId,
  onAccentChange,
  thinkingStyle,
  onThinkingStyleChange,
  sidebarTokensVisible,
  onSidebarTokensVisibleChange,
  chatCostVisible,
  onChatCostVisibleChange,
  launcherGlobeVisible,
  onLauncherGlobeVisibleChange,
  newSessionMode,
  onNewSessionModeChange
}: {
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  thinkingStyle: ThinkingStyle;
  onThinkingStyleChange: (style: ThinkingStyle) => void;
  sidebarTokensVisible: boolean;
  onSidebarTokensVisibleChange: (v: boolean) => void;
  chatCostVisible: boolean;
  onChatCostVisibleChange: (v: boolean) => void;
  launcherGlobeVisible: boolean;
  onLauncherGlobeVisibleChange: (v: boolean) => void;
  newSessionMode: NewSessionMode;
  onNewSessionModeChange: (mode: NewSessionMode) => void;
}): JSX.Element {
  return (
    <>
      <section className="settings-section" id="settings-local" aria-labelledby="settings-local-h">
        <SectionHeader
          index={0}
          id="settings-local-h"
          eyebrow="Identity"
          title="Local profile"
          description="Argmax runs locally on this machine — there is no cloud account."
        />
        <div className="settings-card">
          <div className="settings-account">
            <span className="settings-avatar" aria-hidden="true">
              <span className="settings-avatar-glyph">▲</span>
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
          index={1}
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
            legend="Thinking indicator"
            name="thinking-style"
            value={thinkingStyle}
            onChange={(v) => onThinkingStyleChange(v as ThinkingStyle)}
            options={[
              { value: "terminal", label: "Terminal command", caption: "default" },
              { value: "verbs", label: "Playful verbs" }
            ]}
          />
          <p className="settings-hint">
            {thinkingStyle === "verbs"
              ? "Shows a rotating verb (“Gusting…”, “Pondering…”) while the model thinks."
              : "Types “argmax run --model …” as a terminal-style command while the model thinks."}
          </p>

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
            label="Animated globe on the launcher"
            description="Show a rotating dot-globe behind the new-session screen. Pauses when reduced-motion is on."
            checked={launcherGlobeVisible}
            onChange={onLauncherGlobeVisibleChange}
          />

          <KeyValueList
            rows={[
              { dt: "Reduce motion", dd: "Follows OS setting" }
            ]}
          />
        </div>
      </section>

      <section className="settings-section" id="settings-defaults" aria-labelledby="settings-defaults-h">
        <SectionHeader
          index={2}
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
