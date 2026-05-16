import {
  ChevronDown,
  ClipboardCopy,
  ExternalLink,
  FolderOpen,
  Key,
  RefreshCcw,
  X
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type {
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  IdeId,
  LogEntry,
  McpClientListing,
  ProjectSummary
} from "../../shared/types.js";
import { FONT_OPTIONS, type FontFamilyId, type FontOption } from "../lib/fonts.js";
import { formatBytes } from "../lib/formatBytes.js";
import { useAsyncLoad } from "../hooks/useAsyncLoad.js";
import { readFirstContentMeasure } from "../lib/paintTimings.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { NewSessionMode } from "../lib/newSessionMode.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { CombinedModelSelector } from "./ModelSelector.js";
import { ProjectKnowledgePanel } from "./ProjectKnowledgePanel.js";
// McpAuthDialog pulls in @xterm/xterm + @xterm/addon-fit + xterm CSS — heavy
// for a dialog that only opens on click. Lazy-mounted (ralph B3) so the
// SettingsPanel chunk doesn't drag xterm into the launcher → Settings load.
const McpAuthDialog = lazy(async () => ({
  default: (await import("./McpAuthDialog.js")).McpAuthDialog
}));

const PROVIDER_INSTALL_HINTS: Record<string, { label: string; url: string }> = {
  claude: {
    label: "Install Claude Code CLI",
    url: "https://docs.claude.com/en/docs/claude-code/install"
  },
  codex: {
    label: "Install Codex CLI",
    url: "https://github.com/openai/codex"
  }
};

const MCP_TRANSPORT_LABELS: Record<string, string> = {
  stdio: "stdio",
  http: "http",
  sse: "sse",
  unknown: "unknown"
};

const MCP_CLIENT_HINTS: Record<string, string> = {
  claude: "Configured via the `claude mcp add` CLI or by editing `~/.claude.json`.",
  codex: "Configured under `[mcp_servers.NAME]` in `~/.codex/config.toml`.",
  cursor: "Configured via Cursor's MCP settings or by editing `~/.cursor/mcp.json`."
};

type SettingsGroupId = "general" | "agents" | "integrations" | "system";
type SettingsSectionMeta = { id: string; label: string };
type SettingsGroupMeta = {
  id: SettingsGroupId;
  label: string;
  title: string;
  eyebrow: string;
  description: string;
  railNote: string;
  sections: ReadonlyArray<SettingsSectionMeta>;
};

const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupMeta> = [
  {
    id: "general",
    label: "General",
    title: "Shape the workspace",
    eyebrow: "Local console",
    description: "The everyday feel of Argmax: identity, typography, launch behavior, and visible session detail.",
    railNote: "Look · launch · local",
    sections: [
      { id: "settings-local", label: "Local profile" },
      { id: "settings-appearance", label: "Appearance" },
      { id: "settings-defaults", label: "Launch defaults" }
    ]
  },
  {
    id: "agents",
    label: "Agents",
    title: "Tune agent behavior",
    eyebrow: "Model sessions",
    description: "Provider defaults, tool-call visibility, and the permission stance every new session starts with.",
    railNote: "Models · tools · risk",
    sections: [
      { id: "settings-agent-defaults", label: "Model defaults" },
      { id: "settings-permissions", label: "Permissions" },
      { id: "settings-providers", label: "Providers" }
    ]
  },
  {
    id: "integrations",
    label: "Integrations",
    title: "Connect local tools",
    eyebrow: "Handoffs",
    description: "Editors and MCP servers Argmax can discover, reveal, or authenticate from this machine.",
    railNote: "IDE · MCP",
    sections: [
      { id: "settings-tools", label: "Default IDE" },
      { id: "settings-mcp", label: "MCP servers" }
    ]
  },
  {
    id: "system",
    label: "System",
    title: "Inspect the engine room",
    eyebrow: "On-device state",
    description: "Project knowledge, runtime diagnostics, local database health, logs, and app details.",
    railNote: "Memory · diagnostics",
    sections: [
      { id: "settings-knowledge", label: "Project knowledge" },
      { id: "settings-diagnostics", label: "Diagnostics" },
      { id: "settings-about", label: "About" }
    ]
  }
];

const DEFAULT_SETTINGS_GROUP = SETTINGS_GROUPS[0];

function settingsGroupById(id: SettingsGroupId): SettingsGroupMeta {
  return SETTINGS_GROUPS.find((group) => group.id === id) ?? DEFAULT_SETTINGS_GROUP;
}

function sectionNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function SettingsPanel({
  defaultModel,
  onDefaultModelChange,
  toolCallsExpanded,
  onToolCallsExpandedChange,
  sidebarTokensVisible,
  onSidebarTokensVisibleChange,
  fontFamily,
  onFontFamilyChange,
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
  sidebarTokensVisible: boolean;
  onSidebarTokensVisibleChange: (v: boolean) => void;
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
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
  const {
    data: providers,
    error: providerLoadError,
    isLoading: refreshingProviders,
    retry: refreshProviders
  } = useAsyncLoad<DiscoveredProvider[]>(
    () => window.argmax!.providers.discover(),
    {
      missingApiMessage: "Open the Electron app window to detect providers.",
      fallbackMessage: "Provider discovery failed."
    }
  );

  const {
    data: mcpListings,
    error: mcpLoadError,
    isLoading: refreshingMcp,
    retry: refreshMcp
  } = useAsyncLoad<McpClientListing[]>(() => window.argmax!.mcp.list(), {
    missingApiMessage: "Open the Electron app window to read MCP configs.",
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
            <span className="settings-hero-rule-tail">└── single user · zero telemetry · ready</span>
          </div>
        </header>

        <SettingsGroupIntro group={activeGroupMeta} />

        <div className="settings-group-panel" role="region" aria-labelledby="settings-group-heading">
          {activeGroup === "general" ? (
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
            description="Pick the monospace font Argmax uses everywhere — chat, code, sidebar, everything."
          />
          <div className="settings-card">
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

            <KeyValueList
              rows={[
                { dt: "Theme", dd: "Light · paper grain" },
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
          ) : null}

          {activeGroup === "integrations" ? (
            <>
        <section className="settings-section" id="settings-tools" aria-labelledby="settings-tools-h">
          <SectionHeader
            index={0}
            id="settings-tools-h"
            eyebrow="Editor handoff"
            title="Default IDE"
            description='Pick the editor that opens when you click the "Open in IDE" button on a session.'
          />
          <div className="settings-card">
            <div className="settings-row">
              <label htmlFor="settings-default-ide">Default IDE</label>
              <select
                id="settings-default-ide"
                aria-label="Default IDE"
                className="settings-select"
                value={defaultIde ?? ""}
                onChange={(event) => {
                  const next = event.target.value;
                  onDefaultIdeChange(next === "" ? null : (next as IdeId));
                }}
                disabled={detectedIdes.length === 0}
              >
                <option value="">Ask each time</option>
                {detectedIdes.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </div>
            {detectedIdes.length === 0 ? (
              <p className="settings-hint">
                No supported IDEs detected. Install VS Code, Cursor, Windsurf, or Zed to enable this.
              </p>
            ) : null}
          </div>
        </section>

            </>
          ) : null}

          {activeGroup === "agents" ? (
            <>
        <section className="settings-section" id="settings-agent-defaults" aria-labelledby="settings-agent-defaults-h">
          <SectionHeader
            index={0}
            id="settings-agent-defaults-h"
            eyebrow="Session defaults"
            title="Model defaults"
            description="Pick the model that pre-fills the launcher when you start a new session, and choose how much tool-call detail is visible by default."
          />
          <div className="settings-card">
            <div className="settings-row">
              <label htmlFor="settings-default-model">Default model</label>
              <CombinedModelSelector
                ariaLabel="Default model"
                inputId="settings-default-model"
                value={defaultModel}
                onChange={onDefaultModelChange}
              />
            </div>
            <Segmented
              legend="Tool calls"
              name="tool-calls-expand"
              value={toolCallsExpanded ? "show" : "hide"}
              onChange={(v) => onToolCallsExpandedChange(v === "show")}
              options={[
                { value: "show", label: "Show expanded" },
                { value: "hide", label: "Show collapsed" }
              ]}
            />
          </div>
        </section>

        <section className="settings-section" id="settings-permissions" aria-labelledby="settings-permissions-h">
          <SectionHeader
            index={1}
            id="settings-permissions-h"
            eyebrow="Risk gate"
            title="Permissions"
            description="Controls how each provider session treats commands the agent wants to run."
          />
          <div className="settings-card">
            <Segmented
              legend="When the agent wants to run a command"
              name="permission-mode"
              value={permissionMode}
              onChange={(v) => onPermissionModeChange(v as PermissionMode)}
              options={[
                { value: "auto-approve", label: "Auto-approve", caption: "default" },
                { value: "ask-each-time", label: "Ask each time" }
              ]}
            />
            {permissionMode === "auto-approve" ? (
              <p className="settings-hint">
                Argmax launches each provider with broad permissions
                (<code>bypassPermissions</code> / <code>--dangerously-bypass-approvals-and-sandbox</code> /
                <code> --force --trust</code>). Suitable for a trusted single-user desktop —
                switch to "Ask each time" if you want an explicit gate per tool call.
              </p>
            ) : (
              <p className="settings-hint">
                The bypass flags are dropped. Each tool invocation goes through the provider's
                native approval gate; Argmax surfaces it as an in-app Approve / Reject prompt.
              </p>
            )}
          </div>
        </section>

        <section className="settings-section" id="settings-providers" aria-labelledby="settings-providers-h">
          <SectionHeader
            index={2}
            id="settings-providers-h"
            eyebrow="Discovery"
            title="Providers"
            description="Detected CLI agents. Argmax discovers them on launch; click refresh after installing one."
            action={
              <button
                type="button"
                className="settings-refresh"
                onClick={() => void refreshProviders()}
                disabled={refreshingProviders}
                aria-label="Refresh provider discovery"
              >
                <RefreshCcw size={13} aria-hidden="true" className={refreshingProviders ? "is-spinning" : undefined} />
                <span>{refreshingProviders ? "Refreshing…" : "Refresh"}</span>
              </button>
            }
          />
          <div className="settings-card settings-card-flush">
            {providerLoadError ? (
              <p className="settings-hint" role="alert">
                {providerLoadError}
              </p>
            ) : null}
            {providers && providers.length > 0 ? (
              <ul className="settings-providers-list">
                {providers.map((provider) => {
                  const installHint = PROVIDER_INSTALL_HINTS[provider.provider];
                  return (
                    <li
                      key={provider.provider}
                      className="settings-provider-row"
                      data-installed={provider.installed ? "true" : "false"}
                    >
                      <span className="settings-provider-dot" aria-hidden="true" />
                      <div className="settings-provider-meta">
                        <span className="settings-provider-name">{provider.displayName}</span>
                        <span className="settings-provider-status">
                          {provider.installed
                            ? provider.version
                              ? `Installed · v${provider.version}`
                              : "Installed"
                            : "Not found on PATH"}
                        </span>
                      </div>
                      {!provider.installed && installHint ? (
                        <a
                          className="settings-provider-link"
                          href={installHint.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{installHint.label}</span>
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : providers ? (
              <p className="settings-hint">No providers reported by discovery.</p>
            ) : (
              <p className="settings-hint">Detecting providers…</p>
            )}
          </div>
        </section>

            </>
          ) : null}

          {activeGroup === "integrations" ? (
            <>
        <section className="settings-section" id="settings-mcp" aria-labelledby="settings-mcp-h">
          <SectionHeader
            index={1}
            id="settings-mcp-h"
            eyebrow="Model Context Protocol"
            title="MCP servers"
            description={
              <>
                MCP servers configured for each CLI. Argmax reads the user-scope config files.
                For Claude Code, click <em>Authenticate</em> to run <code>/mcp</code> in-app;
                Codex and Cursor don’t expose a CLI auth flow, so edit their config files
                directly to manage credentials.
              </>
            }
            action={
              <button
                type="button"
                className="settings-refresh"
                onClick={() => void refreshMcp()}
                disabled={refreshingMcp}
                aria-label="Refresh MCP server list"
              >
                <RefreshCcw size={13} aria-hidden="true" className={refreshingMcp ? "is-spinning" : undefined} />
                <span>{refreshingMcp ? "Refreshing…" : "Refresh"}</span>
              </button>
            }
          />
          <div className="settings-mcp-body">
            {mcpLoadError ? (
              <p className="settings-hint" role="alert">
                {mcpLoadError}
              </p>
            ) : null}
            {mcpListings ? (
              mcpListings.map((listing) => (
                <div key={listing.client} className="settings-mcp-client">
                  <div className="settings-mcp-client-header">
                    <span className="settings-mcp-client-name">{listing.displayName}</span>
                    <span className="settings-mcp-client-count">
                      {listing.configExists
                        ? `${listing.servers.length} ${listing.servers.length === 1 ? "server" : "servers"}`
                        : "No config file"}
                    </span>
                    {listing.client === "claude" ? (
                      <button
                        type="button"
                        className="settings-mcp-auth"
                        onClick={() => setMcpAuthOpen(true)}
                        aria-label="Authenticate Claude MCP servers"
                        title="Run `claude` and open the /mcp auth picker"
                      >
                        <Key size={12} aria-hidden="true" />
                        <span>Authenticate via Claude (/mcp)</span>
                      </button>
                    ) : null}
                  </div>
                  {listing.error ? (
                    <p className="settings-hint" role="alert">
                      Couldn’t read this config: {listing.error}
                    </p>
                  ) : null}
                  {listing.configExists && listing.servers.length === 0 && !listing.error ? (
                    <p className="settings-hint">
                      No MCP servers configured. {MCP_CLIENT_HINTS[listing.client]}
                    </p>
                  ) : null}
                  {!listing.configExists ? (
                    <p className="settings-hint">
                      {listing.configPath
                        ? `Argmax checked ${listing.configPath} — not found yet. ${MCP_CLIENT_HINTS[listing.client] ?? ""}`
                        : MCP_CLIENT_HINTS[listing.client]}
                    </p>
                  ) : null}
                  {listing.servers.length > 0 ? (
                    <ul className="settings-mcp-server-list">
                      {listing.servers.map((server) => {
                        const detail = server.url ?? server.command ?? "";
                        return (
                          <li key={`${listing.client}:${server.name}`} className="settings-mcp-server-row">
                            <div className="settings-mcp-server-meta">
                              <div className="settings-mcp-server-line">
                                <span className="settings-mcp-server-name">{server.name}</span>
                                <span
                                  className="settings-mcp-server-badge"
                                  data-transport={server.transport}
                                  title={`Transport: ${server.transport}`}
                                >
                                  {MCP_TRANSPORT_LABELS[server.transport] ?? server.transport}
                                </span>
                              </div>
                              {detail ? (
                                <span className="settings-mcp-server-detail" title={detail}>
                                  {detail}
                                </span>
                              ) : null}
                              {server.envKeys.length > 0 ? (
                                <span className="settings-mcp-server-envs">
                                  env: {server.envKeys.join(", ")}
                                </span>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {listing.configPath ? (
                    <button
                      type="button"
                      className="settings-mcp-config-link"
                      onClick={() => void revealMcpConfig(listing.configPath as string)}
                      title={listing.configPath}
                    >
                      <FolderOpen size={12} aria-hidden="true" />
                      <span>Reveal config</span>
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="settings-hint">Reading MCP configs…</p>
            )}
          </div>
        </section>

            </>
          ) : null}

          {activeGroup === "system" ? (
            <>
        <section className="settings-section" id="settings-knowledge" aria-labelledby="settings-knowledge-h">
          <SectionHeader
            index={0}
            id="settings-knowledge-h"
            eyebrow="Memory"
            title="Project knowledge"
            description="Learnings Argmax has captured from your sessions. The top-K of these are injected as a preamble for every new launch — verified ones stick to the top of the list."
          />
          <ProjectKnowledgePanel projects={projects} />
        </section>

        <section className="settings-section" id="settings-diagnostics" aria-labelledby="settings-diagnostics-h">
          <SectionHeader
            index={1}
            id="settings-diagnostics-h"
            eyebrow="Telemetry"
            title="Diagnostics"
            description="Runtime details for bug reports. No data leaves the machine."
          />
          <div className="settings-card">
            {diagnostics ? (
              <KeyValueList
                rows={[
                  { dt: "App version", dd: diagnostics.appVersion },
                  { dt: "Electron", dd: diagnostics.electronVersion || "unknown" },
                  { dt: "Node", dd: diagnostics.nodeVersion },
                  { dt: "SQLite", dd: diagnostics.sqliteVersion },
                  { dt: "Platform", dd: `${diagnostics.platform} · ${diagnostics.arch}` },
                  {
                    dt: "Database",
                    dd: <span className="settings-diagnostics-path">{diagnostics.databasePath}</span>
                  }
                ]}
              />
            ) : (
              <p className="settings-hint">Loading runtime details…</p>
            )}
            <div className="settings-diagnostics-actions">
              <button
                type="button"
                onClick={() => void copyDiagnostics()}
                disabled={!diagnostics}
                aria-label="Copy diagnostics"
              >
                <ClipboardCopy size={13} aria-hidden="true" />
                <span>Copy diagnostics</span>
              </button>
              <button
                type="button"
                onClick={() => void revealDatabase()}
                disabled={!diagnostics}
                aria-label="Reveal database file"
              >
                <FolderOpen size={13} aria-hidden="true" />
                <span>Reveal database</span>
              </button>
              <button type="button" onClick={() => void vacuumDatabase()} aria-label="Vacuum database">
                <span>Vacuum database</span>
              </button>
              <button
                type="button"
                onClick={() => saveLogsFile(diagnostics?.recentLogs ?? [], setDiagnosticsStatus)}
                disabled={!diagnostics || diagnostics.recentLogs.length === 0}
                aria-label="Save log file"
              >
                <span>Save log file</span>
              </button>
            </div>
            {diagnosticsStatus ? (
              <p className="settings-hint settings-diagnostics-status" role="status">
                <span className="settings-diagnostics-status-dot" aria-hidden="true" />
                {diagnosticsStatus}
              </p>
            ) : null}
          </div>

          {diagnostics?.databaseStats ? (
            <div className="settings-card" aria-labelledby="settings-diagnostics-database">
              <h3 id="settings-diagnostics-database" className="settings-card-title">
                Database
              </h3>
              <p className="settings-hint">
                Row counts across the live SQLite store.
              </p>
              <dl className="settings-keyvals settings-metric-grid">
                <div>
                  <dt>Projects</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.projects.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Workspaces</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.workspaces.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Sessions</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.sessions.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Events</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.events.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Raw outputs</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.rawOutputs.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Approvals</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.approvals.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Checks</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.checks.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Checkpoints</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.checkpoints.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Learnings</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.learnings.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Usage events</dt>
                  <dd>{diagnostics.databaseStats.rowCounts.usageEvents.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>WAL size</dt>
                  <dd>{formatBytes(diagnostics.databaseStats.walBytes)}</dd>
                </div>
                <div>
                  <dt>WAL autocheckpoint</dt>
                  <dd>{diagnostics.databaseStats.walAutocheckpoint.toLocaleString()} pages</dd>
                </div>
              </dl>
            </div>
          ) : null}

          {diagnostics?.recentLogs?.length ? (
            <div className="settings-card" aria-labelledby="settings-diagnostics-logs">
              <h3 id="settings-diagnostics-logs" className="settings-card-title">
                Recent logs
              </h3>
              <p className="settings-hint">
                Main-process ring buffer tail. Refreshes when this panel re-opens. Use{" "}
                <em>Copy diagnostics</em> to capture the full payload for a bug report.
              </p>
              <ul className="settings-logs-list" aria-label="Recent log entries">
                {diagnostics.recentLogs.map((entry, index) => (
                  <li
                    key={`${entry.timestamp}-${index}`}
                    data-log-level={entry.level}
                    className="settings-logs-entry"
                  >
                    <span className="settings-logs-dot" aria-hidden="true" />
                    <span className="settings-logs-timestamp">{entry.timestamp}</span>
                    <span className="settings-logs-level">{entry.level}</span>
                    <code className="settings-logs-scope">{entry.scope}</code>
                    <span className="settings-logs-message">{entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diagnostics?.ipcStats?.length ? (
            <div className="settings-card" aria-labelledby="settings-diagnostics-ipc">
              <h3 id="settings-diagnostics-ipc" className="settings-card-title">
                IPC latency
              </h3>
              <p className="settings-hint">
                Per-channel p50 / p99 across the last 100 invocations. Refreshes when this panel
                re-opens or you click <em>Copy diagnostics</em>.
              </p>
              <table className="settings-startup-table" aria-label="IPC channel latency">
                <thead>
                  <tr>
                    <th scope="col">Channel</th>
                    <th scope="col">Count</th>
                    <th scope="col">p50</th>
                    <th scope="col">p99</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.ipcStats.map((stat) => (
                    <tr key={stat.channel}>
                      <td>
                        <code>{stat.channel}</code>
                      </td>
                      <td>{stat.count.toLocaleString()}</td>
                      <td>{stat.p50.toFixed(2)} ms</td>
                      <td>{stat.p99.toFixed(2)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {diagnostics?.startupPhases?.length ? (
            <div className="settings-card" aria-labelledby="settings-diagnostics-startup">
              <h3 id="settings-diagnostics-startup" className="settings-card-title">
                Startup phases
              </h3>
              <ColdStartSummary phases={diagnostics.startupPhases} />
              <p className="settings-hint">
                Cold-start timing for the current boot. Budget: 1500&nbsp;ms to <code>ready-to-show</code>.
                See <code>agents/docs/performance.md</code>.
              </p>
              <table className="settings-startup-table" aria-label="Startup phase timings">
                <thead>
                  <tr>
                    <th scope="col">Phase</th>
                    <th scope="col">Elapsed</th>
                    <th scope="col">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.startupPhases.map((phase) => {
                    const overBudget = phase.phase === "window.ready-to-show" && phase.elapsedMs > 1500;
                    return (
                      <tr key={phase.phase} data-over-budget={overBudget || undefined}>
                        <td>
                          <code>{phase.phase}</code>
                          {overBudget ? (
                            <span className="settings-badge" role="status">
                              over budget
                            </span>
                          ) : null}
                        </td>
                        <td>{phase.elapsedMs.toFixed(2)} ms</td>
                        <td>{phase.deltaMs.toFixed(2)} ms</td>
                      </tr>
                    );
                  })}
                  <RendererPaintRow />
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="settings-section" id="settings-about" aria-labelledby="settings-about-h">
          <SectionHeader
            index={2}
            id="settings-about-h"
            eyebrow="Colophon"
            title="About"
            description="The fine print."
          />
          <div className="settings-card">
            <KeyValueList
              rows={[
                { dt: "App", dd: "Argmax" },
                { dt: "Runtime", dd: "Electron · single-user local" },
                { dt: "Providers", dd: "Claude Code · Codex" }
              ]}
            />
          </div>
        </section>

            </>
          ) : null}
        </div>

        <footer className="settings-footer" aria-hidden="true">
          <span className="settings-footer-prompt">argmax@local</span>
          <span className="settings-footer-sep">·</span>
          <span>preferences saved instantly</span>
          <span className="settings-footer-sep">·</span>
          <span>zero telemetry</span>
          <span className="settings-footer-caret">▍</span>
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

const COLD_START_BUDGET_MS = 1500;

function ColdStartSummary({
  phases
}: {
  phases: DiagnosticsReport["startupPhases"];
}): JSX.Element | null {
  const ready = phases.find((p) => p.phase === "window.ready-to-show");
  if (!ready) return null;
  const overBudget = ready.elapsedMs > COLD_START_BUDGET_MS;
  return (
    <div
      className="settings-coldstart-summary"
      role="status"
      aria-label="Cold start budget summary"
      data-over-budget={overBudget || undefined}
    >
      <span className="settings-coldstart-label">Cold start</span>
      <span className="settings-coldstart-value">{ready.elapsedMs.toFixed(0)} ms</span>
      <span className="settings-coldstart-budget">
        (budget: {COLD_START_BUDGET_MS} ms)
      </span>
      <span className="settings-coldstart-status" role="img" aria-hidden="true">
        {overBudget ? "⚠" : "✓"}
      </span>
      {overBudget ? (
        <span className="settings-badge" data-tone="warn">
          over budget
        </span>
      ) : null}
    </div>
  );
}

function RendererPaintRow(): JSX.Element | null {
  const measureMs = readFirstContentMeasure();
  if (measureMs === null) return null;
  return (
    <tr data-paint-timing="first-content">
      <td>
        <code>renderer.first-content</code>
      </td>
      <td>{measureMs.toFixed(2)} ms</td>
      <td>—</td>
    </tr>
  );
}

function SettingsGroupIntro({ group }: { group: SettingsGroupMeta }): JSX.Element {
  return (
    <section className="settings-group-intro" aria-labelledby="settings-group-heading">
      <div>
        <p className="settings-section-eyebrow">{group.eyebrow}</p>
        <h2 id="settings-group-heading">{group.title}</h2>
        <p>{group.description}</p>
      </div>
      <ol className="settings-group-map" aria-label={`${group.label} settings in this group`}>
        {group.sections.map((section, index) => (
          <li key={section.id}>
            <span>{sectionNumber(index)}</span>
            <span>{section.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SettingsNav({
  active,
  onChange
}: {
  active: SettingsGroupId;
  onChange: (group: SettingsGroupId) => void;
}): JSX.Element {
  return (
    <aside className="settings-nav" aria-label="Settings groups">
      <p className="settings-nav-eyebrow">Settings</p>
      <ol className="settings-nav-list">
        {SETTINGS_GROUPS.map((group, index) => {
          const isActive = group.id === active;
          return (
            <li key={group.id} className="settings-nav-item" data-active={isActive ? "true" : "false"}>
              <button
                type="button"
                className="settings-nav-link"
                aria-pressed={isActive}
                onClick={() => onChange(group.id)}
              >
                <span className="settings-nav-num">{sectionNumber(index)}</span>
                <span className="settings-nav-rule" aria-hidden="true" />
                <span className="settings-nav-copy">
                  <span className="settings-nav-label">{group.label}</span>
                  <span className="settings-nav-note">{group.railNote}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="settings-nav-foot">
        <span>{settingsGroupById(active).sections.length} sections · instant save</span>
      </p>
    </aside>
  );
}

function SectionHeader({
  index,
  id,
  eyebrow,
  title,
  description,
  action
}: {
  index: number;
  id: string;
  eyebrow: string;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <header className="settings-section-header">
      <span className="settings-section-marker" aria-hidden="true">{sectionNumber(index)}</span>
      <div className="settings-section-titles">
        <p className="settings-section-eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
        <p className="settings-section-desc">{description}</p>
      </div>
      {action ? <div className="settings-section-action">{action}</div> : null}
    </header>
  );
}

function KeyValueList({ rows }: { rows: ReadonlyArray<{ dt: string; dd: ReactNode }> }): JSX.Element {
  return (
    <dl className="settings-keyvals">
      {rows.map((row) => (
        <div key={row.dt}>
          <dt>{row.dt}</dt>
          <dd>{row.dd}</dd>
        </div>
      ))}
    </dl>
  );
}

type SegmentedOption = { value: string; label: string; caption?: string };

function Segmented({
  legend,
  name,
  value,
  onChange,
  options
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<SegmentedOption>;
}): JSX.Element {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={legend}>
      <span className="settings-segmented-legend">{legend}</span>
      <div className="settings-segmented-track" data-count={options.length}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className="settings-segmented-option"
              data-checked={checked ? "true" : "false"}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              <span className="settings-segmented-label">{option.label}</span>
              {option.caption ? (
                <span className="settings-segmented-caption">{option.caption}</span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="settings-checkbox-row settings-toggle-row">
      <div className="settings-toggle-text">
        <span className="settings-toggle-label">{label}</span>
        {description ? <span className="settings-toggle-desc">{description}</span> : null}
      </div>
      <span className="settings-toggle">
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="settings-toggle-track" aria-hidden="true">
          <span className="settings-toggle-thumb" />
        </span>
      </span>
    </label>
  );
}

/**
 * SPEC P8.04 — "Save log file" writes the in-memory log buffer as JSONL and
 * triggers a browser-style download via Blob + anchor click. The renderer
 * can't reach `shell.openPath` without a new main-process IPC; the download
 * dialog is the contained renderer-only path.
 */
function saveLogsFile(entries: ReadonlyArray<LogEntry>, setStatus: (status: string | null) => void): void {
  if (entries.length === 0) {
    setStatus("No log entries to save.");
    return;
  }
  try {
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `argmax-logs-${stamp}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setStatus(`Saved ${entries.length} log entries.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save log file.");
  }
}

function FontFamilyPicker({
  value,
  onChange,
  inputId
}: {
  value: FontFamilyId;
  onChange: (id: FontFamilyId) => void;
  inputId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));
  const selected: FontOption = FONT_OPTIONS.find((o) => o.id === value) ?? FONT_OPTIONS[0];

  return (
    <div className="settings-picker" ref={anchorRef}>
      <button
        type="button"
        id={inputId}
        className="settings-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Font family"
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontFamily: selected.stack }}>{selected.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <ul
          className="project-picker-popover settings-picker-popover"
          role="listbox"
          aria-label="Font family"
          onClick={(event) => {
            if (!(event.target instanceof Element && event.target.closest("button.project-picker-item"))) {
              setOpen(false);
            }
          }}
        >
          {FONT_OPTIONS.map((option) => {
            const isSelected = option.id === value;
            return (
              <li key={option.id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  className="project-picker-item"
                  aria-pressed={isSelected}
                  style={{ fontFamily: option.stack }}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
