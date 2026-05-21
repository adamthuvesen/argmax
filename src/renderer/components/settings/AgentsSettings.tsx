import { ExternalLink, RefreshCcw } from "lucide-react";
import type { JSX } from "react";
import type { DiscoveredProvider } from "../../../shared/types.js";
import type { ModelPickerSelection } from "../../lib/models.js";
import type { PermissionMode } from "../../lib/permissionMode.js";
import { CombinedModelSelector } from "../ModelSelector.js";
import { SectionHeader, Segmented } from "./settingsPrimitives.js";

export const PROVIDER_INSTALL_HINTS: Record<string, { label: string; url: string }> = {
  claude: {
    label: "Install Claude Code CLI",
    url: "https://docs.claude.com/en/docs/claude-code/install"
  },
  codex: {
    label: "Install Codex CLI",
    url: "https://github.com/openai/codex"
  }
};

export function AgentsSettings({
  defaultModel,
  onDefaultModelChange,
  toolCallsExpanded,
  onToolCallsExpandedChange,
  toolCallGroupsExpanded,
  onToolCallGroupsExpandedChange,
  permissionMode,
  onPermissionModeChange,
  providers,
  providerLoadError,
  refreshingProviders,
  refreshProviders
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  toolCallsExpanded: boolean;
  onToolCallsExpandedChange: (v: boolean) => void;
  toolCallGroupsExpanded: boolean;
  onToolCallGroupsExpandedChange: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  providers: DiscoveredProvider[] | null;
  providerLoadError: string | null;
  refreshingProviders: boolean;
  refreshProviders: () => void;
}): JSX.Element {
  return (
    <>
      <section className="settings-section" id="settings-agent-defaults" aria-labelledby="settings-agent-defaults-h">
        <SectionHeader
          index={0}
          id="settings-agent-defaults-h"
          eyebrow="Session defaults"
          title="Model defaults"
          description="Pick the model that pre-fills the launcher when you start a new session, and choose how much tool-call detail is visible by default. The two tool-call toggles are independent — keep the chat-level chip expanded while collapsing inner group bubbles, or any other combination."
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
            legend="Tool calls in chat"
            name="tool-calls-expand"
            value={toolCallsExpanded ? "show" : "hide"}
            onChange={(v) => onToolCallsExpandedChange(v === "show")}
            options={[
              { value: "show", label: "Show expanded" },
              { value: "hide", label: "Show collapsed" }
            ]}
          />
          <p className="settings-hint">
            Controls the “Working for…” chip on each turn — whether the tool
            activity for a turn is visible by default.
          </p>
          <Segmented
            legend="Tool call groups"
            name="tool-call-groups-expand"
            value={toolCallGroupsExpanded ? "show" : "hide"}
            onChange={(v) => onToolCallGroupsExpandedChange(v === "show")}
            options={[
              { value: "show", label: "Show expanded" },
              { value: "hide", label: "Show collapsed" }
            ]}
          />
          <p className="settings-hint">
            Controls the inner bubbles like “Explored 6 files” — when collapsed,
            you see the summary instead of every individual tool row.
          </p>
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
  );
}
