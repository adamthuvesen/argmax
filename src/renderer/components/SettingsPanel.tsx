import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type {
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  IdeId,
  ProjectSummary
} from "../../shared/types.js";
import type { FontFamilyId, FontSizeId } from "../lib/fonts.js";
import type { ThemeMode } from "../lib/theme.js";
import type { AccentId } from "../lib/accent.js";
import { useAsyncLoad } from "../hooks/useAsyncLoad.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { NewSessionMode } from "../lib/newSessionMode.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import type { ChatWidth } from "../lib/chatWidth.js";
import { AgentsSettings } from "./settings/AgentsSettings.js";
import { GeneralSettings } from "./settings/GeneralSettings.js";
import { IntegrationsSettings } from "./settings/IntegrationsSettings.js";
import {
  DEFAULT_SETTINGS_GROUP,
  type SettingsGroupId,
  settingsGroupById
} from "./settings/settingsMeta.js";
import { SettingsGroupIntro, SettingsNav } from "./settings/settingsPrimitives.js";
import { SystemSettings } from "./settings/SystemSettings.js";

export type SettingsNavigationTarget = {
  group: SettingsGroupId;
  sectionId?: string;
  requestId: number;
};

export function SettingsPanel({
  defaultModel,
  onDefaultModelChange,
  toolCallsExpanded,
  onToolCallsExpandedChange,
  toolCallGroupsExpanded,
  onToolCallGroupsExpandedChange,
  sidebarTokensVisible,
  onSidebarTokensVisibleChange,
  chatCostVisible,
  onChatCostVisibleChange,
  pixelFieldEnabled,
  onPixelFieldEnabledChange,
  chatWidth,
  onChatWidthChange,
  thinkingExpanded,
  onThinkingExpandedChange,
  fastModeEnabled,
  onFastModeEnabledChange,
  fontFamily,
  onFontFamilyChange,
  fontSize,
  onFontSizeChange,
  themeMode,
  onThemeModeChange,
  accentId,
  onAccentChange,
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  permissionMode,
  onPermissionModeChange,
  newSessionMode,
  onNewSessionModeChange,
  projects,
  navigationTarget
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  toolCallsExpanded: boolean;
  onToolCallsExpandedChange: (v: boolean) => void;
  toolCallGroupsExpanded: boolean;
  onToolCallGroupsExpandedChange: (v: boolean) => void;
  sidebarTokensVisible: boolean;
  onSidebarTokensVisibleChange: (v: boolean) => void;
  chatCostVisible: boolean;
  onChatCostVisibleChange: (v: boolean) => void;
  pixelFieldEnabled: boolean;
  onPixelFieldEnabledChange: (v: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidthChange: (width: ChatWidth) => void;
  thinkingExpanded: boolean;
  onThinkingExpandedChange: (v: boolean) => void;
  fastModeEnabled: boolean;
  onFastModeEnabledChange: (v: boolean) => void;
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
  fontSize: FontSizeId;
  onFontSizeChange: (id: FontSizeId) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  newSessionMode: NewSessionMode;
  onNewSessionModeChange: (mode: NewSessionMode) => void;
  projects: ProjectSummary[];
  navigationTarget?: SettingsNavigationTarget | null;
}): JSX.Element {
  // First load reuses the cached reports; every explicit "Refresh" (retry)
  // forces a re-probe so a provider installed after boot is actually detected.
  const hasDiscoveredRef = useRef(false);
  const {
    data: providers,
    error: providerLoadError,
    isLoading: refreshingProviders,
    retry: refreshProviders
  } = useAsyncLoad<DiscoveredProvider[]>(
    () => {
      const force = hasDiscoveredRef.current;
      hasDiscoveredRef.current = true;
      return window.argmax!.providers.discover(force);
    },
    {
      missingApiMessage: "Open the Tauri app window to detect providers.",
      fallbackMessage: "Provider discovery failed."
    }
  );

  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    if (!window.argmax) return;
    try {
      const report = await window.argmax.system.diagnostics();
      setDiagnostics(report);
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : "Could not load diagnostics.");
    }
  }, []);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const copyDiagnostics = useCallback(async (): Promise<void> => {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsStatus("Diagnostics copied to clipboard.");
    } catch {
      setDiagnosticsStatus("Clipboard unavailable. Copy from the visible fields below.");
    }
  }, [diagnostics]);

  const revealDatabase = useCallback(async (): Promise<void> => {
    if (!window.argmax || !diagnostics) return;
    try {
      await window.argmax.system.openPath({ path: diagnostics.databasePath });
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : "Could not reveal database file.");
    }
  }, [diagnostics]);

  const vacuumDatabase = useCallback(async (): Promise<void> => {
    if (!window.argmax) return;
    setDiagnosticsStatus("Vacuuming…");
    try {
      await window.argmax.system.vacuumDatabase();
      setDiagnosticsStatus("Database vacuum complete.");
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : "Vacuum failed.");
    }
  }, []);

  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // The panel is lazy-mounted behind Suspense, so App's "scroll settings to top"
  // reset fires while only the skeleton is present and no-ops. Pin the scroll
  // container to the top once the real content is in the DOM, otherwise the
  // Suspense reveal can leave it mid-scroll with the first section under the bar.
  useLayoutEffect(() => {
    const scroller = surfaceRef.current?.closest(".settings-scroll");
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  }, []);

  const [activeGroup, setActiveGroup] = useState<SettingsGroupId>(DEFAULT_SETTINGS_GROUP.id);
  const handledNavigationRequestRef = useRef<number | null>(null);
  const activeGroupMeta = settingsGroupById(activeGroup);
  const scrollSettings = useCallback((sectionId?: string): void => {
    window.requestAnimationFrame(() => {
      const scroller = surfaceRef.current?.closest(".settings-scroll");
      if (!(scroller instanceof HTMLElement)) return;
      if (!sectionId) {
        if (typeof scroller.scrollTo === "function") {
          scroller.scrollTo({ top: 0 });
        } else {
          scroller.scrollTop = 0;
        }
        return;
      }

      const section = document.getElementById(sectionId);
      if (!(section instanceof HTMLElement) || !scroller.contains(section)) return;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: section.offsetTop });
      } else {
        scroller.scrollTop = section.offsetTop;
      }
    });
  }, []);

  const handleGroupChange = useCallback((next: SettingsGroupId): void => {
    setActiveGroup(next);
    scrollSettings();
  }, [scrollSettings]);

  useEffect(() => {
    if (!navigationTarget) return;
    if (handledNavigationRequestRef.current === navigationTarget.requestId) return;
    if (activeGroup !== navigationTarget.group) {
      setActiveGroup(navigationTarget.group);
      return;
    }
    handledNavigationRequestRef.current = navigationTarget.requestId;
    scrollSettings(navigationTarget.sectionId);
  }, [activeGroup, navigationTarget, scrollSettings]);

  return (
    <>
      <header className="settings-topbar" data-window-drag>
        <div className="settings-topbar-inner">
          <h1 className="settings-topbar-title">Settings</h1>
          <span className="settings-topbar-sep" aria-hidden="true">/</span>
          <span className="settings-topbar-group">{activeGroupMeta.label}</span>
        </div>
      </header>

      <div className="settings-surface" ref={surfaceRef}>
        <SettingsNav active={activeGroup} onChange={handleGroupChange} />

        <div className="settings-main">
          <SettingsGroupIntro group={activeGroupMeta} />

        <div className="settings-group-panel" role="region" aria-labelledby="settings-group-heading">
          {activeGroup === "general" ? (
            <GeneralSettings
              fontFamily={fontFamily}
              onFontFamilyChange={onFontFamilyChange}
              fontSize={fontSize}
              onFontSizeChange={onFontSizeChange}
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              accentId={accentId}
              onAccentChange={onAccentChange}
              sidebarTokensVisible={sidebarTokensVisible}
              onSidebarTokensVisibleChange={onSidebarTokensVisibleChange}
              chatCostVisible={chatCostVisible}
              onChatCostVisibleChange={onChatCostVisibleChange}
              pixelFieldEnabled={pixelFieldEnabled}
              onPixelFieldEnabledChange={onPixelFieldEnabledChange}
              chatWidth={chatWidth}
              onChatWidthChange={onChatWidthChange}
              newSessionMode={newSessionMode}
              onNewSessionModeChange={onNewSessionModeChange}
            />
          ) : null}

          {activeGroup === "agents" ? (
            <AgentsSettings
              defaultModel={defaultModel}
              onDefaultModelChange={onDefaultModelChange}
              toolCallsExpanded={toolCallsExpanded}
              onToolCallsExpandedChange={onToolCallsExpandedChange}
              toolCallGroupsExpanded={toolCallGroupsExpanded}
              onToolCallGroupsExpandedChange={onToolCallGroupsExpandedChange}
              thinkingExpanded={thinkingExpanded}
              onThinkingExpandedChange={onThinkingExpandedChange}
              fastModeEnabled={fastModeEnabled}
              onFastModeEnabledChange={onFastModeEnabledChange}
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              providers={providers}
              providerLoadError={providerLoadError}
              refreshingProviders={refreshingProviders}
              refreshProviders={() => {
                void refreshProviders();
              }}
            />
          ) : null}

          {activeGroup === "integrations" ? (
            <IntegrationsSettings
              detectedIdes={detectedIdes}
              defaultIde={defaultIde}
              onDefaultIdeChange={onDefaultIdeChange}
            />
          ) : null}

          {activeGroup === "system" ? (
            <SystemSettings
              projects={projects}
              diagnostics={diagnostics}
              diagnosticsStatus={diagnosticsStatus}
              setDiagnosticsStatus={setDiagnosticsStatus}
              copyDiagnostics={copyDiagnostics}
              revealDatabase={revealDatabase}
              vacuumDatabase={vacuumDatabase}
            />
          ) : null}
        </div>
      </div>

      </div>
    </>
  );
}
