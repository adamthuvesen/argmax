import { AlertTriangle, ChartNoAxesColumn, ExternalLink, RefreshCcw } from "lucide-react";
import { useMemo, type JSX } from "react";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../../shared/providerModels.js";
import type { DiscoveredProvider } from "../../../shared/types.js";
import { effortLabel, type ModelPickerSelection } from "../../lib/models.js";
import type { PermissionMode } from "../../lib/permissionMode.js";
import { PROVIDER_INSTALL_HINTS } from "../../lib/providerInstallHints.js";
import { CHAT_VERBOSITY_HINTS, CHAT_VERBOSITY_LABELS, type ChatVerbosity } from "../../lib/uiPreferences.js";
import { CombinedModelSelector, type ProviderAvailability } from "../ModelSelector.js";
import { WorkingNest } from "../WorkingNest.js";
import {
  SegmentedControl,
  SettingGroup,
  SettingNote,
  SettingRow,
  SettingsListPicker,
  Slider,
  Toggle
} from "./settingsPrimitives.js";

export function AgentsSettings({
  defaultModel,
  onDefaultModelChange,
  defaultEffort,
  onDefaultEffortChange,
  chatVerbosity,
  onChatVerbosityChange,
  fastModeEnabled,
  onFastModeEnabledChange,
  turnChangesExpanded,
  onTurnChangesExpandedChange,
  permissionMode,
  onPermissionModeChange,
  providers,
  providerLoadError,
  refreshingProviders,
  refreshProviders,
  onOpenUsage
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  defaultEffort: ReasoningEffort;
  onDefaultEffortChange: (effort: ReasoningEffort) => void;
  chatVerbosity: ChatVerbosity;
  onChatVerbosityChange: (verbosity: ChatVerbosity) => void;
  fastModeEnabled: boolean;
  onFastModeEnabledChange: (v: boolean) => void;
  turnChangesExpanded: boolean;
  onTurnChangesExpandedChange: (v: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  providers: DiscoveredProvider[] | null;
  providerLoadError: string | null;
  refreshingProviders: boolean;
  refreshProviders: () => void;
  /** Leaves settings for the Usage page — what these providers have cost. */
  onOpenUsage: () => void;
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
      <SettingGroup id="settings-agent-defaults" label="Defaults">
        <SettingRow
          label="Default model"
          description="Pre-fills the launcher when you start a chat. Stored for the app, not per project."
          htmlFor="settings-default-model"
          control={
            <CombinedModelSelector
              ariaLabel="Default model"
              availability={providerAvailability}
              inputId="settings-default-model"
              value={defaultModel}
              onChange={onDefaultModelChange}
            />
          }
        />
        <SettingRow
          label="Default effort"
          description="How hard the model thinks by default. Models offer different levels — one that doesn't go this high runs at Medium instead."
          htmlFor="settings-default-effort"
          control={
            <SettingsListPicker
              ariaLabel="Default effort"
              inputId="settings-default-effort"
              value={defaultEffort}
              onChange={onDefaultEffortChange}
              options={REASONING_EFFORTS.map((effort) => ({ value: effort, label: effortLabel(effort) }))}
            />
          }
        />
        <SettingRow
          label="Fast mode for Claude and Codex"
          description="Launch Claude Code with fast mode and run Codex on the priority service tier."
          control={
            <Toggle
              ariaLabel="Fast mode for Claude and Codex"
              checked={fastModeEnabled}
              onChange={onFastModeEnabledChange}
            />
          }
        />
      </SettingGroup>

      <SettingGroup id="settings-permissions" label="Permissions">
        <SettingRow
          label="When the agent wants to run a command"
          control={
            <SegmentedControl
              ariaLabel="When the agent wants to run a command"
              name="permission-mode"
              value={permissionMode}
              onChange={(v) => onPermissionModeChange(v as PermissionMode)}
              options={[
                { value: "auto-approve", label: "Auto-approve" },
                {
                  value: "ask-each-time",
                  label: "Ask each time",
                  disabled: !askEachTimeAvailable,
                  caption: askEachTimeAvailable
                    ? undefined
                    : "Unavailable until a provider supports live replies"
                }
              ]}
            />
          }
        />
        {!askEachTimeAvailable ? (
          <SettingNote>
            No detected provider can answer a live approval request yet. Choose Auto-approve to start a
            chat; Argmax will not pretend that an observable-only gate can be approved in-app.
          </SettingNote>
        ) : permissionMode === "auto-approve" ? (
          <SettingNote>
            Argmax launches each provider with broad permissions (<code>bypassPermissions</code> /{" "}
            <code>--dangerously-bypass-approvals-and-sandbox</code> / <code>--force --trust</code>).
            Right for a trusted single-user desktop — switch to “Ask each time” for an explicit gate
            per tool call.
          </SettingNote>
        ) : (
          <SettingNote>
            The bypass flags are dropped. Each tool invocation goes through a provider's native
            approval gate only when that provider supports live replies.
          </SettingNote>
        )}
      </SettingGroup>

      <SettingGroup id="settings-conversation" label="Conversation">
        <SettingRow
          label="Chat detail & verbosity"
          description={CHAT_VERBOSITY_HINTS[chatVerbosity]}
          control={
            <Slider
              ariaLabel="Chat detail & verbosity"
              min={1}
              max={5}
              value={chatVerbosity}
              valueLabel={CHAT_VERBOSITY_LABELS[chatVerbosity]}
              onChange={(v) => onChatVerbosityChange(v as ChatVerbosity)}
            />
          }
        />
        <SettingRow
          label="Changed files expanded"
          description="Show the file list under each finished turn instead of just the header."
          control={
            <Toggle
              ariaLabel="Changed files expanded"
              checked={turnChangesExpanded}
              onChange={onTurnChangesExpandedChange}
            />
          }
        />
      </SettingGroup>

      <SettingGroup
        id="settings-providers"
        label="Providers"
        action={
          <>
            <button type="button" className="settings-button" onClick={onOpenUsage}>
              <ChartNoAxesColumn size={13} aria-hidden="true" />
              <span>View usage</span>
            </button>
            <button
              type="button"
              className="settings-button"
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
          </>
        }
      >
        {providerLoadError ? <SettingNote role="alert">{providerLoadError}</SettingNote> : null}
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
              const approvalText =
                provider.approvalSupport === "respondable"
                  ? "live approvals"
                  : provider.approvalSupport === "observable-only"
                    ? "approvals observable only"
                    : "no native approvals";
              return (
                <li key={provider.provider} className="settings-provider-row" data-installed={dataState}>
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
                    <span className="settings-provider-status">
                      {statusText} · {approvalText}
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
          <SettingNote>No providers reported by discovery.</SettingNote>
        ) : (
          <SettingNote>Detecting providers…</SettingNote>
        )}
      </SettingGroup>
    </>
  );
}
