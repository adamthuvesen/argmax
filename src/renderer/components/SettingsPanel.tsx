import { X } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  IdeId,
  McpClientListing,
  ProjectSummary
} from "../../shared/types.js";
import type { FontFamilyId } from "../lib/fonts.js";
import type { ThemeMode } from "../lib/theme.js";
import type { AccentId } from "../lib/accent.js";
import { useAsyncLoad } from "../hooks/useAsyncLoad.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { NewSessionMode } from "../lib/newSessionMode.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
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

// McpAuthDialog pulls in @xterm/xterm + @xterm/addon-fit + xterm CSS — heavy
// for a dialog that only opens on click. Lazy-mounted (ralph B3) so the
// SettingsPanel chunk doesn't drag xterm into the launcher → Settings load.
const McpAuthDialog = lazy(async () => ({
  default: (await import("./McpAuthDialog.js")).McpAuthDialog
}));

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
  launcherGlobeVisible,
  onLauncherGlobeVisibleChange,
  thinkingExpanded,
  onThinkingExpandedChange,
  fontFamily,
  onFontFamilyChange,
  themeMode,
  onThemeModeChange,
  accentId,
  onAccentChange,
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  permissionMode,
  onPermissionModeChange,
  thinkingStyle,
  onThinkingStyleChange,
  newSessionMode,
  onNewSessionModeChange,
  projects,
  onClose
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
  launcherGlobeVisible: boolean;
  onLauncherGlobeVisibleChange: (v: boolean) => void;
  thinkingExpanded: boolean;
  onThinkingExpandedChange: (v: boolean) => void;
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentId: AccentId;
  onAccentChange: (accentId: AccentId) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  thinkingStyle: ThinkingStyle;
  onThinkingStyleChange: (style: ThinkingStyle) => void;
  newSessionMode: NewSessionMode;
  onNewSessionModeChange: (mode: NewSessionMode) => void;
  projects: ProjectSummary[];
  onClose: () => void;
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

  const {
    data: mcpListings,
    error: mcpLoadError,
    isLoading: refreshingMcp,
    retry: refreshMcp
  } = useAsyncLoad<McpClientListing[]>(() => window.argmax!.mcp.list(), {
    missingApiMessage: "Open the Tauri app window to read MCP configs.",
    fallbackMessage: "MCP discovery failed."
  });

  const revealMcpConfig = useCallback(async (path: string): Promise<void> => {
    if (!window.argmax) return;
    try {
      await window.argmax.system.openPath({ path });
    } catch {
      // Silently swallow — the UI shows the path inline so the user has a fallback.
    }
  }, []);

  const [mcpAuthOpen, setMcpAuthOpen] = useState(false);

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
  const [activeGroup, setActiveGroup] = useState<SettingsGroupId>(DEFAULT_SETTINGS_GROUP.id);
  const activeGroupMeta = settingsGroupById(activeGroup);
  const handleGroupChange = useCallback((next: SettingsGroupId): void => {
    setActiveGroup(next);
    window.requestAnimationFrame(() => {
      const scroller = surfaceRef.current?.closest(".settings-scroll");
      if (scroller instanceof HTMLElement) {
        if (typeof scroller.scrollTo === "function") {
          scroller.scrollTo({ top: 0 });
        } else {
          scroller.scrollTop = 0;
        }
      }
    });
  }, []);

  const heroMetaParts = useMemo(() => {
    const parts: string[] = ["Preferences", "Local"];
    if (diagnostics) {
      parts.push(`v${diagnostics.appVersion}`);
      parts.push(`${diagnostics.platform}/${diagnostics.arch}`);
    }
    return parts;
  }, [diagnostics]);

  return (
    <div className="settings-surface" ref={surfaceRef}>
      <SettingsNav active={activeGroup} onChange={handleGroupChange} />

      <div className="settings-main">
        <header className="settings-hero">
          <div className="settings-hero-meta-top">
            <span className="settings-hero-dot" aria-hidden="true" />
            <span className="eyebrow settings-hero-eyebrow">
              {heroMetaParts.join(" · ")}
            </span>
            <button
              className="settings-hero-close"
              type="button"
              title="Close settings"
              aria-label="Close settings"
              onClick={onClose}
            >
              <X size={14} aria-hidden="true" />
              <span className="settings-hero-close-label">close</span>
              <kbd className="settings-hero-close-kbd" aria-hidden="true">Esc</kbd>
            </button>
          </div>
          <h1 className="settings-hero-title">
            Settings<span className="settings-hero-period" aria-hidden="true">.</span>
          </h1>
          <p className="settings-hero-lede">
            A hand-built console for tuning Argmax. Everything here lives on this machine —
            no cloud account, no telemetry, no sync.
          </p>
          <div className="settings-hero-rule" aria-hidden="true">
            <span>└── single user · zero telemetry · ready</span>
          </div>
        </header>

        <SettingsGroupIntro group={activeGroupMeta} />

        <div className="settings-group-panel" role="region" aria-labelledby="settings-group-heading">
          {activeGroup === "general" ? (
            <GeneralSettings
              fontFamily={fontFamily}
              onFontFamilyChange={onFontFamilyChange}
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              accentId={accentId}
              onAccentChange={onAccentChange}
              thinkingStyle={thinkingStyle}
              onThinkingStyleChange={onThinkingStyleChange}
              sidebarTokensVisible={sidebarTokensVisible}
              onSidebarTokensVisibleChange={onSidebarTokensVisibleChange}
              chatCostVisible={chatCostVisible}
              onChatCostVisibleChange={onChatCostVisibleChange}
              launcherGlobeVisible={launcherGlobeVisible}
              onLauncherGlobeVisibleChange={onLauncherGlobeVisibleChange}
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
              mcpListings={mcpListings}
              mcpLoadError={mcpLoadError}
              refreshingMcp={refreshingMcp}
              refreshMcp={() => {
                void refreshMcp();
              }}
              revealMcpConfig={revealMcpConfig}
              onMcpAuthOpen={() => setMcpAuthOpen(true)}
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

        <footer className="settings-footer" aria-hidden="true">
          <span className="settings-footer-prompt">argmax@local</span>
          <span className="settings-footer-sep">·</span>
          <span>preferences saved instantly</span>
          <span className="settings-footer-sep">·</span>
          <span>zero telemetry</span>
        </footer>
      </div>

      {mcpAuthOpen ? (
        <Suspense fallback={null}>
          <McpAuthDialog
            open={mcpAuthOpen}
            onClose={() => setMcpAuthOpen(false)}
            onCompleted={() => {
              void refreshMcp();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
