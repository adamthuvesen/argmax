import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Plus,
  RefreshCcw,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import type { DiscoveredProvider } from "../../shared/types.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { PROVIDER_INSTALL_HINTS } from "../lib/providerInstallHints.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../lib/providerSetup.js";
import { WorkingNest } from "./WorkingNest.js";

/**
 * Fresh-install onboarding surface. Renders when the user has no projects
 * registered yet, as a three-step checklist: connect at least one agent CLI,
 * optionally wire up MCP servers, then add the first project.
 *
 * The "Add Project" CTA is disabled until at least one provider is detected —
 * Argmax launches a CLI agent per session, so a project with zero installed
 * providers has nothing to launch.
 */
export function WelcomePane({ onAddProject }: { onAddProject: () => void }): JSX.Element {
  const [providers, setProviders] = useState<DiscoveredProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (force: boolean): Promise<void> => {
    if (!window.argmax) {
      setLoadError("Open the Tauri app window to detect providers.");
      return;
    }
    setRefreshing(true);
    setLoadError(null);
    try {
      const discovered = await window.argmax.providers.discover(force);
      setProviders(discovered);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Provider discovery failed.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial detection reuses the cached reports; "Try again" forces a re-probe.
    void refresh(false);
  }, [refresh]);

  const anyInstalled = providers !== null && providers.some((p) => p.installed);
  const allReady =
    providers !== null &&
    providers.length > 0 &&
    providers.every((p) => p.installed && p.authenticated !== false);

  useEffect(() => {
    // Installing or logging in happens in the user's own terminal. Re-probe
    // when the app window regains focus so the checklist updates the moment
    // they switch back, instead of waiting for a manual "Try again".
    if (providers === null || allReady) return;
    const onFocus = (): void => {
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [providers, allReady, refresh]);

  return (
    <div className="launcher-surface welcome-pane" aria-labelledby="welcome-title">
      <header className="welcome-header">
        <h1 id="welcome-title">Welcome to Argmax</h1>
        <p className="welcome-tagline">
          Argmax runs AI coding agents on your machine — in isolated git worktrees or your
          current checkout. Three steps and you&apos;re working.
        </p>
      </header>

      <section className="welcome-section" aria-labelledby="welcome-providers">
        <header className="welcome-section-header">
          <div className="welcome-section-heading">
            <span className="welcome-step" aria-hidden="true">1</span>
            <h2 id="welcome-providers">Connect your coding agents</h2>
          </div>
          <button
            type="button"
            className="welcome-refresh"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            aria-label="Re-run provider discovery"
          >
            {refreshing ? (
              <WorkingNest active size={14} />
            ) : (
              <RefreshCcw size={14} aria-hidden="true" />
            )}
            <span>{refreshing ? "Detecting…" : "Try again"}</span>
          </button>
        </header>
        <p className="welcome-hint">
          Install and log in to the agents you want — one is enough to start. Run the commands in
          your terminal; Argmax re-checks when you switch back to this window.
        </p>
        {loadError ? (
          <p className="welcome-error" role="alert">{loadError}</p>
        ) : providers === null ? (
          <p className="welcome-hint">Looking for installed providers…</p>
        ) : providers.length === 0 ? (
          <p className="welcome-hint">No providers configured.</p>
        ) : (
          <ul className="welcome-providers" aria-label="Detected providers">
            {providers.map((entry) => {
              const hint = PROVIDER_INSTALL_HINTS[entry.provider];
              const setup = PROVIDER_SETUP[entry.provider];
              // Three states: not installed, installed-but-needs-login (auth
              // probe returned false), and ready. An inconclusive probe
              // (authenticated === null) is treated as ready — advisory only.
              const needsLogin = entry.installed && entry.authenticated === false;
              const dataState = !entry.installed ? "false" : needsLogin ? "needs-login" : "true";
              return (
                <li
                  key={entry.provider}
                  className="welcome-provider"
                  data-installed={dataState}
                >
                  <div className="welcome-provider-head">
                    {!entry.installed ? (
                      <XCircle size={16} aria-hidden="true" className="welcome-provider-icon missing" />
                    ) : needsLogin ? (
                      <AlertTriangle size={16} aria-hidden="true" className="welcome-provider-icon needs-login" />
                    ) : (
                      <CheckCircle2 size={16} aria-hidden="true" className="welcome-provider-icon installed" />
                    )}
                    <span className="welcome-provider-name">{entry.displayName}</span>
                    {entry.version ? (
                      <span className="welcome-provider-version">v{entry.version}</span>
                    ) : null}
                    <span className="welcome-provider-state">
                      {!entry.installed ? "Not installed" : needsLogin ? "Needs login" : "Ready"}
                    </span>
                  </div>
                  {!entry.installed && setup ? (
                    <div className="welcome-provider-actions">
                      <CommandSnippet
                        command={setup.installCommand}
                        copyLabel={`Copy ${entry.displayName} install command`}
                      />
                      {hint ? (
                        <a
                          className="welcome-install-link"
                          href={hint.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {hint.label}
                          <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  ) : needsLogin ? (
                    <div className="welcome-provider-actions">
                      {entry.setupGuidance ? (
                        <p className="welcome-provider-guidance">{entry.setupGuidance}</p>
                      ) : null}
                      {setup ? (
                        <CommandSnippet
                          command={setup.loginCommand}
                          copyLabel={`Copy ${entry.displayName} login command`}
                        />
                      ) : null}
                    </div>
                  ) : entry.setupGuidance ? (
                    <p className="welcome-provider-guidance">{entry.setupGuidance}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="welcome-section" aria-labelledby="welcome-mcp">
        <details className="welcome-mcp">
          <summary>
            <span className="welcome-step" aria-hidden="true">2</span>
            <h2 id="welcome-mcp">Connect MCP servers <span className="welcome-optional">optional</span></h2>
          </summary>
          <p className="welcome-hint">
            Argmax launches each agent with your existing configuration, so MCP servers you add to a
            CLI show up in Argmax sessions automatically — nothing to configure here.
          </p>
          <ul className="welcome-mcp-list">
            {PROVIDER_SETUP_ORDER.map((providerId) => {
              const setup = PROVIDER_SETUP[providerId];
              return (
                <li key={providerId} className="welcome-mcp-row">
                  <span className="welcome-mcp-name">{setup.displayName}</span>
                  {setup.mcpCommand ? (
                    <CommandSnippet
                      command={setup.mcpCommand}
                      copyLabel={`Copy ${setup.displayName} MCP command`}
                    />
                  ) : null}
                  <p className="welcome-hint">{setup.mcpHint}</p>
                </li>
              );
            })}
          </ul>
        </details>
      </section>

      <section className="welcome-section welcome-cta" aria-labelledby="welcome-project">
        <div className="welcome-section-heading">
          <span className="welcome-step" aria-hidden="true">3</span>
          <h2 id="welcome-project">Add your first project</h2>
        </div>
        <p className="welcome-hint">
          Pick any local git repository. Sessions run in your checkout or in isolated worktrees
          under it.
        </p>
        <button
          className="primary-action"
          type="button"
          onClick={onAddProject}
          disabled={!anyInstalled}
          title={anyInstalled ? "Pick a local git repository" : "Install at least one provider CLI first"}
          aria-disabled={!anyInstalled}
        >
          <Plus size={18} />
          Add Project
        </button>
        {!anyInstalled && providers !== null ? (
          <p className="welcome-hint">
            Install at least one provider CLI above, then click <strong>Try again</strong>.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function CommandSnippet({ command, copyLabel }: { command: string; copyLabel: string }): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();
  return (
    <div className="welcome-command">
      <code>{command}</code>
      <button
        type="button"
        className="welcome-copy"
        onClick={() => void copy(command)}
        aria-label={copyLabel}
      >
        {copyFlash === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        <span>{copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy"}</span>
      </button>
    </div>
  );
}
