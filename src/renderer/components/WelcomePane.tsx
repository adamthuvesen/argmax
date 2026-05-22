import { CheckCircle2, ExternalLink, Plus, RefreshCcw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import type { DiscoveredProvider } from "../../shared/types.js";
import { PROVIDER_INSTALL_HINTS } from "../lib/providerInstallHints.js";

/**
 * Fresh-install onboarding surface. Renders when the user has no projects
 * registered yet — replaces the previous bare "Add a project" empty state
 * with a setup checklist that surfaces detected providers + install hints.
 *
 * The "Add Project" CTA is disabled until at least one provider is detected —
 * Argmax launches a CLI agent per session, so a project with zero installed
 * providers has nothing to launch.
 */
export function WelcomePane({ onAddProject }: { onAddProject: () => void }): JSX.Element {
  const [providers, setProviders] = useState<DiscoveredProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setLoadError("Open the Electron app window to detect providers.");
      return;
    }
    setRefreshing(true);
    setLoadError(null);
    try {
      const discovered = await window.argmax.providers.discover();
      setProviders(discovered);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Provider discovery failed.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyInstalled = providers !== null && providers.some((p) => p.installed);

  return (
    <div className="launcher-surface welcome-pane" aria-labelledby="welcome-title">
      <h1 id="welcome-title">Welcome to Argmax</h1>
      <p className="welcome-tagline">
        Argmax runs AI coding agents in parallel git worktrees on your machine. To get
        started, install one or more provider CLIs, then add a project.
      </p>

      <section className="welcome-section" aria-labelledby="welcome-providers">
        <header className="welcome-section-header">
          <h2 id="welcome-providers">Detected providers</h2>
          <button
            type="button"
            className="welcome-refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Re-run provider discovery"
          >
            <RefreshCcw size={14} aria-hidden="true" />
            <span>{refreshing ? "Detecting…" : "Try again"}</span>
          </button>
        </header>
        {loadError ? (
          <p className="welcome-error" role="alert">{loadError}</p>
        ) : providers === null ? (
          <p className="welcome-hint">Looking for installed providers…</p>
        ) : providers.length === 0 ? (
          <p className="welcome-hint">No providers configured.</p>
        ) : (
          <ul className="welcome-providers">
            {providers.map((entry) => {
              const hint = PROVIDER_INSTALL_HINTS[entry.provider];
              return (
                <li
                  key={entry.provider}
                  className="welcome-provider"
                  data-installed={entry.installed ? "true" : "false"}
                >
                  <div className="welcome-provider-head">
                    {entry.installed ? (
                      <CheckCircle2 size={16} aria-hidden="true" className="welcome-provider-icon installed" />
                    ) : (
                      <XCircle size={16} aria-hidden="true" className="welcome-provider-icon missing" />
                    )}
                    <span className="welcome-provider-name">{entry.displayName}</span>
                    {entry.version ? (
                      <span className="welcome-provider-version">v{entry.version}</span>
                    ) : null}
                  </div>
                  {entry.installed ? null : hint ? (
                    <a
                      className="welcome-install-link"
                      href={hint.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {hint.label}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : entry.setupGuidance ? (
                    <p className="welcome-provider-guidance">{entry.setupGuidance}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
    </div>
  );
}
