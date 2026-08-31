import { AlertTriangle, ExternalLink, RefreshCcw } from "lucide-react";
import { useMemo, type JSX } from "react";
import type { DiscoveredProvider } from "../../../shared/types.js";
import type { ModelPickerSelection } from "../../lib/models.js";
import type { PermissionMode } from "../../lib/permissionMode.js";
import { PROVIDER_INSTALL_HINTS } from "../../lib/providerInstallHints.js";
import {
  CHAT_VERBOSITY_HINTS,
  CHAT_VERBOSITY_OPTIONS,
  type ChatVerbosity
} from "../../lib/uiPreferences.js";
import { CombinedModelSelector, type ProviderAvailability } from "../ModelSelector.js";
import { WorkingNest } from "../WorkingNest.js";
import { SectionHeader, Segmented, ToggleRow } from "./settingsPrimitives.js";

export function AgentsSettings({
  defaultModel,
  onDefaultModelChange,
  chatVerbosity,
  onChatVerbosityChange,
  fastModeEnabled,
  onFastModeEnabledChange,
  permissionMode,
  onPermissionModeChange,
  providers,
  providerLoadError,
  refreshingProviders,
  refreshProviders
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  chatVerbosity: ChatVerbosity;
  onChatVerbosityChange: (verbosity: ChatVerbosity) => void;
  fastModeEnabled: boolean;
  onFastModeEnabledChange: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  providers: DiscoveredProvider[] | null;
  providerLoadError: string | null;
  refreshingProviders: boolean;
  refreshProviders: () => void;
}): JSX.Element {
  // Mirror discovery into the default-model picker so uninstalled providers are
  // disabled and unauthenticated ones are annotated, matching the launcher.
  const providerAvailability = useMemo<ProviderAvailability | undefined>(() => {
    if (!providers) return undefined;
    const map: ProviderAvailability = {};
    for (const entry of providers) {
      map[entry.provider] = { installed: entry.installed, authenticated: entry.authenticated };
    }
    return map;
  }, [providers]);
  const askEachTimeAvailable =
    providers === null || providers.some((provider) => provider.approvalSupport === "respondable");

  return (
    <>
      <section className="settings-section" id="settings-agent-defaults" aria-labelledby="settings-agent-defaults-h">
        <SectionHeader
          id="settings-agent-defaults-h"
          eyebrow="Session defaults"
          title="Model defaults"
          description="Pick the model that pre-fills the launcher when you start a new session. The choice is stored for the whole app, not per project. Also choose how much tool-call and thinking detail is visible by default."
        />
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-default-model">Default model</label>
            <CombinedModelSelector
              ariaLabel="Default model"
              availability={providerAvailability}
              inputId="settings-default-model"
              value={defaultModel}
              onChange={onDefaultModelChange}
            />
          </div>
          <Segmented
            legend="Chat detail & verbosity"
            hint={CHAT_VERBOSITY_HINTS[chatVerbosity]}
            name="chat-verbosity"
            value={String(chatVerbosity)}
            onChange={(v) => onChatVerbosityChange(Number(v) as ChatVerbosity)}
            options={CHAT_VERBOSITY_OPTIONS}
          />
          <ToggleRow
            label="Fast mode for Claude and Codex"
            description="Launch Claude Code with fast mode and run Codex on the priority service tier."
            checked={fastModeEnabled}
            onChange={onFastModeEnabledChange}
          />
        </div>
      </section>

      <section className="settings-section" id="settings-permissions" aria-labelledby="settings-permissions-h">
        <SectionHeader
          id="settings-permissions-h"
          eyebrow="Approvals"
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
              { value: "auto-approve", label: "Auto-approve" },
              {
                value: "ask-each-time",
                label: "Ask each time",
                disabled: !askEachTimeAvailable,
                caption: askEachTimeAvailable ? undefined : "Unavailable until a provider supports live replies"
              }
            ]}
          />
          {!askEachTimeAvailable ? (
            <p className="settings-hint">
              No detected provider can answer a live approval request yet. Choose Auto-approve to start a session;
              Argmax will not pretend that an observable-only gate can be approved in-app.
            </p>
          ) : permissionMode === "auto-approve" ? (
            <p className="settings-hint">
              Argmax launches each provider with broad permissions
              (<code>bypassPermissions</code> / <code>--dangerously-bypass-approvals-and-sandbox</code> /
              <code> --force --trust</code>). Suitable for a trusted single-user desktop —
              switch to "Ask each time" if you want an explicit gate per tool call.
            </p>
          ) : (
            <p className="settings-hint">
              The bypass flags are dropped. Each tool invocation goes through a provider's
              native approval gate only when that provider supports live replies.
            </p>
          )}
        </div>
      </section>

      <section className="settings-section" id="settings-providers" aria-labelledby="settings-providers-h">
        <SectionHeader
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
              {refreshingProviders ? (
                <WorkingNest active size={13} />
              ) : (
                <RefreshCcw size={13} aria-hidden="true" />
              )}
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
                // Inconclusive auth (authenticated === null) reads as ready —
                // the badge is advisory and never blocks.
                const needsLogin = provider.installed && provider.authenticated === false;
                const dataState = !provider.installed ? "false" : needsLogin ? "needs-login" : "true";
                const statusText = !provider.installed
                  ? "Not found on PATH"
                  : provider.version
                    ? `Installed · v${provider.version}`
                    : "Installed";
                return (
                  <li
                    key={provider.provider}
                    className="settings-provider-row"
                    data-installed={dataState}
                  >
                    <span className="settings-provider-dot" aria-hidden="true" />
                    <div className="settings-provider-meta">
                      <span className="settings-provider-name">
                        {provider.displayName}
                        {needsLogin ? (
                          <span className="settings-provider-badge">
                            <AlertTriangle size={11} aria-hidden="true" />
                            Needs login
                          </span>
                        ) : null}
                      </span>
                      <span className="settings-provider-status">{statusText}</span>
                      <span className="settings-provider-status">
                        {provider.approvalSupport === "respondable"
                          ? "Live approvals supported"
                          : provider.approvalSupport === "observable-only"
                            ? "Approval requests are observable only"
                            : "Native approvals unavailable"}
                      </span>
                      {needsLogin && provider.setupGuidance ? (
                        <span className="settings-provider-guidance">{provider.setupGuidance}</span>
                      ) : null}
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
  );
}
