import { ArrowRight } from "lucide-react";
import { useState, type JSX } from "react";
import type { DetectedIde, IdeId } from "../../../shared/types.js";
import {
  isLinkTarget,
  persistLinkTarget,
  readStoredLinkTarget,
  type LinkTarget
} from "../../lib/linkTarget.js";
import type { NewSessionMode } from "../../lib/newSessionMode.js";
import {
  SegmentedControl,
  SettingGroup,
  SettingNote,
  SettingRow,
  SettingsListPicker,
  Toggle
} from "./settingsPrimitives.js";

export function GeneralSettings({
  newSessionMode,
  onNewSessionModeChange,
  randomSessionIconEnabled,
  onRandomSessionIconEnabledChange,
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  onOpenProjects
}: {
  newSessionMode: NewSessionMode;
  onNewSessionModeChange: (mode: NewSessionMode) => void;
  randomSessionIconEnabled: boolean;
  onRandomSessionIconEnabledChange: (v: boolean) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
  onOpenProjects: () => void;
}): JSX.Element {
  // Read at click time by the chat's link handler, so localStorage is the
  // source of truth and no App-level state is needed.
  const [linkTarget, setLinkTarget] = useState<LinkTarget>(readStoredLinkTarget);
  const pickLinkTarget = (raw: string): void => {
    if (!isLinkTarget(raw)) return;
    setLinkTarget(raw);
    persistLinkTarget(raw);
  };

  return (
    <>
      <SettingGroup id="settings-startup" label="Startup">
        <SettingRow
          label="New session"
          description="What ⌘N opens."
          control={
            <SegmentedControl
              ariaLabel="New session"
              name="new-session-mode"
              value={newSessionMode}
              onChange={(v) => onNewSessionModeChange(v as NewSessionMode)}
              options={[
                { value: "embedded", label: "In grid" },
                { value: "full", label: "Full view" }
              ]}
            />
          }
        />
        <SettingRow
          label="Random icon for new sessions"
          description="Give each new session a random icon and color."
          control={
            <Toggle
              ariaLabel="Random icon for new sessions"
              checked={randomSessionIconEnabled}
              onChange={onRandomSessionIconEnabledChange}
            />
          }
        />
      </SettingGroup>

      <SettingGroup id="settings-handoff" label="Handoff">
        <SettingRow
          label="Default IDE"
          description="Opens when you click Open in IDE on a session."
          htmlFor="settings-default-ide"
          control={
            <SettingsListPicker
              ariaLabel="Default IDE"
              inputId="settings-default-ide"
              // A default that isn't detected (e.g. the factory Cursor default
              // on a machine without Cursor) shows as "Ask each time" — the
              // effective behavior — instead of a dangling option.
              value={defaultIde && detectedIdes.some((entry) => entry.id === defaultIde) ? defaultIde : ""}
              onChange={(next) => {
                onDefaultIdeChange(next === "" ? null : next);
              }}
              disabled={detectedIdes.length === 0}
              options={[
                { value: "", label: "Ask each time" },
                ...detectedIdes.map((entry) => ({ value: entry.id, label: entry.label }))
              ]}
            />
          }
        />
        <SettingRow
          label="Web links from chat"
          description="⌘-click always opens the other one."
          control={
            <SegmentedControl
              ariaLabel="Web links from chat"
              name="link-target"
              value={linkTarget}
              onChange={pickLinkTarget}
              options={[
                { value: "system", label: "Default browser" },
                { value: "argmax", label: "Argmax browser" }
              ]}
            />
          }
        />
        {detectedIdes.length === 0 ? (
          <SettingNote>
            No supported IDEs detected. Install VS Code, Cursor, Windsurf, or Zed to enable this.
          </SettingNote>
        ) : null}
      </SettingGroup>

      <SettingGroup id="settings-general-projects" label="Per project">
        <SettingRow
          label="Worktree base, setup command, checks"
          description="Configured for each project, not for the app."
          control={
            <button type="button" className="settings-button" onClick={onOpenProjects}>
              <span>Open Projects</span>
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          }
        />
      </SettingGroup>
    </>
  );
}
