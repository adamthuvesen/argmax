import { ChevronDown, ClipboardCopy, FolderOpen, RefreshCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  IdeId,
  McpClientListing,
  ProjectSummary
} from "../../shared/types.js";
import { FONT_OPTIONS, type FontFamilyId, type FontOption } from "../lib/fonts.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import type { ThinkingStyle } from "../lib/thinkingStyle.js";
import { CombinedModelSelector } from "./ModelSelector.js";
import { ProjectKnowledgePanel } from "./ProjectKnowledgePanel.js";

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

export function SettingsPanel({
  defaultModel,
  onDefaultModelChange,
  toolCallsExpanded,
  onToolCallsExpandedChange,
  fontFamily,
  onFontFamilyChange,
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  permissionMode,
  onPermissionModeChange,
  thinkingStyle,
  onThinkingStyleChange,
  projects,
  onClose
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  toolCallsExpanded: boolean;
  onToolCallsExpandedChange: (v: boolean) => void;
  fontFamily: FontFamilyId;
  onFontFamilyChange: (id: FontFamilyId) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  thinkingStyle: ThinkingStyle;
  onThinkingStyleChange: (style: ThinkingStyle) => void;
  projects: ProjectSummary[];
  onClose: () => void;
}): JSX.Element {
  const [providers, setProviders] = useState<DiscoveredProvider[] | null>(null);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [refreshingProviders, setRefreshingProviders] = useState(false);

  const refreshProviders = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setProviderLoadError("Open the Electron app window to detect providers.");
      return;
    }
    setRefreshingProviders(true);
    setProviderLoadError(null);
    try {
      const discovered = await window.argmax.providers.discover();
      setProviders(discovered);
    } catch (error) {
      setProviderLoadError(error instanceof Error ? error.message : "Provider discovery failed.");
    } finally {
      setRefreshingProviders(false);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const [mcpListings, setMcpListings] = useState<McpClientListing[] | null>(null);
  const [mcpLoadError, setMcpLoadError] = useState<string | null>(null);
  const [refreshingMcp, setRefreshingMcp] = useState(false);

  const refreshMcp = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setMcpLoadError("Open the Electron app window to read MCP configs.");
      return;
    }
    setRefreshingMcp(true);
    setMcpLoadError(null);
    try {
      const listings = await window.argmax.mcp.list();
      setMcpListings(listings);
    } catch (error) {
      setMcpLoadError(error instanceof Error ? error.message : "MCP discovery failed.");
    } finally {
      setRefreshingMcp(false);
    }
  }, []);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  const revealMcpConfig = useCallback(async (path: string): Promise<void> => {
    if (!window.argmax) return;
    try {
      await window.argmax.system.openPath({ path });
    } catch {
      // Silently swallow — the UI shows the path inline so the user has a fallback.
    }
  }, []);

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
  return (
    <div className="settings-surface">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
        </div>
        <button className="small-icon" type="button" title="Close settings" aria-label="Close settings" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <section className="settings-section" aria-labelledby="settings-account">
        <header className="settings-section-header">
          <h2 id="settings-account">Account</h2>
          <p>Argmax runs locally on this machine — there is no cloud account.</p>
        </header>
        <div className="settings-card">
          <div className="settings-account">
            <span className="settings-avatar" aria-hidden="true">M</span>
            <div className="settings-account-meta">
              <span className="settings-account-name">Argmax</span>
              <span className="settings-account-sub">Local · single user</span>
            </div>
          </div>
          <dl className="settings-keyvals">
            <div>
              <dt>Storage</dt>
              <dd>SQLite (on this device)</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Provider calls only · no telemetry</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-appearance">
        <header className="settings-section-header">
          <h2 id="settings-appearance">Appearance</h2>
          <p>Pick the monospace font Argmax uses everywhere — chat, code, sidebar, everything.</p>
        </header>
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-font-family">Font family</label>
            <FontFamilyPicker
              inputId="settings-font-family"
              value={fontFamily}
              onChange={onFontFamilyChange}
            />
          </div>
          <p
            className="settings-font-caption"
            style={{ fontFamily: FONT_OPTIONS.find((o) => o.id === fontFamily)?.stack }}
          >
            {FONT_OPTIONS.find((o) => o.id === fontFamily)?.hint}
          </p>
          <fieldset className="settings-radio-group" aria-label="Thinking indicator">
            <legend>Thinking indicator</legend>
            <label>
              <input
                type="radio"
                name="thinking-style"
                value="terminal"
                checked={thinkingStyle === "terminal"}
                onChange={() => onThinkingStyleChange("terminal")}
              />
              <span>Terminal command (default)</span>
            </label>
            <label>
              <input
                type="radio"
                name="thinking-style"
                value="verbs"
                checked={thinkingStyle === "verbs"}
                onChange={() => onThinkingStyleChange("verbs")}
              />
              <span>Playful verbs</span>
            </label>
          </fieldset>
          <p className="settings-hint">
            {thinkingStyle === "verbs"
              ? "Shows a rotating verb (“Gusting…”, “Pondering…”) while the model thinks."
              : "Types “argmax run --model …” as a terminal-style command while the model thinks."}
          </p>
          <dl className="settings-keyvals">
            <div>
              <dt>Theme</dt>
              <dd>Light</dd>
            </div>
            <div>
              <dt>Reduce motion</dt>
              <dd>Follows OS setting</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-defaults">
        <header className="settings-section-header">
          <h2 id="settings-defaults">Defaults</h2>
          <p>Pick the model that pre-fills the launcher when you start a new session.</p>
        </header>
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
          <fieldset className="settings-radio-group">
            <legend>Tool calls</legend>
            <label>
              <input
                type="radio"
                name="tool-calls-expand"
                value="show"
                checked={toolCallsExpanded}
                onChange={() => onToolCallsExpandedChange(true)}
              />
              <span>Show expanded</span>
            </label>
            <label>
              <input
                type="radio"
                name="tool-calls-expand"
                value="hide"
                checked={!toolCallsExpanded}
                onChange={() => onToolCallsExpandedChange(false)}
              />
              <span>Show collapsed</span>
            </label>
          </fieldset>
          <dl className="settings-keyvals">
            <div>
              <dt>Worktree base</dt>
              <dd>Configured per project</dd>
            </div>
            <div>
              <dt>Setup &amp; check commands</dt>
              <dd>Configured per project</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-tools">
        <header className="settings-section-header">
          <h2 id="settings-tools">Tools</h2>
          <p>Pick the editor that opens when you click the "Open in IDE" button on a session.</p>
        </header>
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-default-ide">Default IDE</label>
            <select
              id="settings-default-ide"
              aria-label="Default IDE"
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

      <section className="settings-section" aria-labelledby="settings-permissions">
        <header className="settings-section-header">
          <h2 id="settings-permissions">Permissions</h2>
          <p>
            Controls how each provider session treats commands the agent wants to run.
          </p>
        </header>
        <div className="settings-card">
          <fieldset className="settings-radio-group" aria-label="Permission mode">
            <legend>When the agent wants to run a command</legend>
            <label>
              <input
                type="radio"
                name="permission-mode"
                value="auto-approve"
                checked={permissionMode === "auto-approve"}
                onChange={() => onPermissionModeChange("auto-approve")}
              />
              <span>Auto-approve (default)</span>
            </label>
            <label>
              <input
                type="radio"
                name="permission-mode"
                value="ask-each-time"
                checked={permissionMode === "ask-each-time"}
                onChange={() => onPermissionModeChange("ask-each-time")}
              />
              <span>Ask each time</span>
            </label>
          </fieldset>
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

      <section className="settings-section" aria-labelledby="settings-providers">
        <header className="settings-section-header settings-section-header-row">
          <div>
            <h2 id="settings-providers">Providers</h2>
            <p>
              Detected CLI agents. Argmax discovers them on launch; click refresh after installing one.
            </p>
          </div>
          <button
            type="button"
            className="settings-refresh"
            onClick={() => void refreshProviders()}
            disabled={refreshingProviders}
            aria-label="Refresh provider discovery"
          >
            <RefreshCcw size={14} />
            <span>{refreshingProviders ? "Refreshing…" : "Refresh"}</span>
          </button>
        </header>
        <div className="settings-providers-body">
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
                        {installHint.label}
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

      <section className="settings-section" aria-labelledby="settings-mcp">
        <header className="settings-section-header settings-section-header-row">
          <div>
            <h2 id="settings-mcp">MCP servers</h2>
            <p>
              MCP servers configured for each CLI. Argmax reads the user-scope config files —
              auth lives inside each CLI, so use its own commands to log in or out.
            </p>
          </div>
          <button
            type="button"
            className="settings-refresh"
            onClick={() => void refreshMcp()}
            disabled={refreshingMcp}
            aria-label="Refresh MCP server list"
          >
            <RefreshCcw size={14} />
            <span>{refreshingMcp ? "Refreshing…" : "Refresh"}</span>
          </button>
        </header>
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
                    <FolderOpen size={12} />
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

      <section className="settings-section" aria-labelledby="settings-knowledge">
        <header className="settings-section-header">
          <h2 id="settings-knowledge">Project knowledge</h2>
          <p>
            Learnings Argmax has captured from your sessions. The top-K of these are injected as a
            preamble for every new launch — verified ones stick to the top of the list.
          </p>
        </header>
        <ProjectKnowledgePanel projects={projects} />
      </section>

      <section className="settings-section" aria-labelledby="settings-diagnostics">
        <header className="settings-section-header">
          <h2 id="settings-diagnostics">Diagnostics</h2>
          <p>Runtime details for bug reports. No data leaves the machine.</p>
        </header>
        <div className="settings-card">
          {diagnostics ? (
            <dl className="settings-keyvals">
              <div>
                <dt>App version</dt>
                <dd>{diagnostics.appVersion}</dd>
              </div>
              <div>
                <dt>Electron</dt>
                <dd>{diagnostics.electronVersion || "unknown"}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{diagnostics.nodeVersion}</dd>
              </div>
              <div>
                <dt>SQLite</dt>
                <dd>{diagnostics.sqliteVersion}</dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd>{`${diagnostics.platform} · ${diagnostics.arch}`}</dd>
              </div>
              <div>
                <dt>Database</dt>
                <dd className="settings-diagnostics-path">{diagnostics.databasePath}</dd>
              </div>
            </dl>
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
              <ClipboardCopy size={14} />
              <span>Copy diagnostics</span>
            </button>
            <button
              type="button"
              onClick={() => void revealDatabase()}
              disabled={!diagnostics}
              aria-label="Reveal database file"
            >
              <FolderOpen size={14} />
              <span>Reveal database</span>
            </button>
            <button type="button" onClick={() => void vacuumDatabase()} aria-label="Vacuum database">
              <span>Vacuum database</span>
            </button>
          </div>
          {diagnosticsStatus ? (
            <p className="settings-hint" role="status">
              {diagnosticsStatus}
            </p>
          ) : null}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-about">
        <header className="settings-section-header">
          <h2 id="settings-about">About</h2>
        </header>
        <div className="settings-card">
          <dl className="settings-keyvals">
            <div>
              <dt>App</dt>
              <dd>Argmax</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>Electron · single-user local</dd>
            </div>
            <div>
              <dt>Providers</dt>
              <dd>Claude Code · Codex</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
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
