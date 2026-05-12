import { ClipboardCopy, FolderOpen, RefreshCcw, X } from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  IdeId,
  ProjectSummary
} from "../../shared/types.js";
import type { ModelPickerSelection } from "../lib/models.js";
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

export function SettingsPanel({
  defaultModel,
  onDefaultModelChange,
  toolCallsExpanded,
  onToolCallsExpandedChange,
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  projects,
  onClose
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  toolCallsExpanded: boolean;
  onToolCallsExpandedChange: (v: boolean) => void;
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
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
          <p>Fonts are locked to Lilex for consistency.</p>
        </header>
        <div className="settings-card">
          <dl className="settings-keyvals">
            <div>
              <dt>Theme</dt>
              <dd>Light</dd>
            </div>
            <div>
              <dt>Font family</dt>
              <dd>Lilex Nerd Font</dd>
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

      <section className="settings-section" aria-labelledby="settings-providers">
        <header className="settings-section-header">
          <h2 id="settings-providers">Providers</h2>
          <p>
            Detected CLI agents. Argmax discovers them on launch; click refresh after installing one.
          </p>
        </header>
        <div className="settings-card">
          <div className="settings-providers-actions">
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
          </div>
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
