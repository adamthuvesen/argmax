import { AlertTriangle, ChartNoAxesColumn, ExternalLink, RefreshCcw } from "lucide-react";
import { useMemo, type JSX } from "react";
import { PROVIDER_DISPLAY_NAMES, REASONING_EFFORTS, type ReasoningEffort } from "../../../shared/providerModels.js";
import type { DiscoveredProvider, ProviderId } from "../../../shared/types.js";
import { effortLabel, type ModelPickerSelection } from "../../lib/models.js";
import type { PermissionMode, ProviderPermissionModes } from "../../lib/permissionMode.js";
import { PROVIDER_INSTALL_HINTS } from "../../lib/providerInstallHints.js";
import {
  CHAT_VERBOSITY_HINTS,
  CHAT_VERBOSITY_LABELS,
  GOAL_MAX_TURNS_MAX,
  GOAL_MAX_TURNS_MIN,
  type ChatVerbosity
} from "../../lib/uiPreferences.js";
import { CombinedModelSelector, type ProviderAvailability } from "../ModelSelector.js";
import { WorkingNest } from "../WorkingNest.js";
import {
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
  goalEnabled,
  onGoalEnabledChange,
  goalMaxTurns,
  onGoalMaxTurnsChange,
  revertEnabled,
  onRevertEnabledChange,
  onTurnChangesExpandedChange,
  defaultAgentSaveError,
  isSavingDefaultAgent,
  onRetryDefaultAgentSave,
  permissionModes,
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
  goalEnabled: boolean;
  onGoalEnabledChange: (v: boolean) => void;
  goalMaxTurns: number;
  onGoalMaxTurnsChange: (v: number) => void;
  revertEnabled: boolean;
  onRevertEnabledChange: (v: boolean) => void;
  onTurnChangesExpandedChange: (v: boolean) => void;
  defaultAgentSaveError?: string | null;
  isSavingDefaultAgent?: boolean;
  onRetryDefaultAgentSave?: () => void;
  permissionModes: ProviderPermissionModes;
  onPermissionModeChange: (provider: ProviderId, mode: PermissionMode) => void;
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
          label="Fast mode"
          description="Request faster responses for supported Codex models, with increased usage. Availability depends on your account."
          control={
            <Toggle
              ariaLabel="Fast mode"
              checked={fastModeEnabled}
              onChange={onFastModeEnabledChange}
            />
          }
        />
      </SettingGroup>

      <SettingGroup id="settings-permissions" label="Permissions">
        {defaultAgentSaveError ? (
          <div role="alert">
            <SettingNote tone="warn">{defaultAgentSaveError}</SettingNote>
            <button type="button" className="settings-button" onClick={onRetryDefaultAgentSave}>Retry saving defaults</button>
          </div>
        ) : isSavingDefaultAgent ? (
          <div role="status"><SettingNote>Saving default settings…</SettingNote></div>
        ) : null}
        {(Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderId[]).map((providerId) => {
          const provider = providers?.find((entry) => entry.provider === providerId);
          const askEachTimeAvailable = !provider || provider.approvalSupport === "respondable";
          const name = PROVIDER_DISPLAY_NAMES[providerId];
          return (
            <SettingRow
              key={providerId}
              label={name}
              htmlFor={`settings-permission-${providerId}`}
              control={
                <SettingsListPicker<PermissionMode>
                  ariaLabel={`${name} tool permissions`}
                  inputId={`settings-permission-${providerId}`}
                  value={permissionModes[providerId]}
                  onChange={(mode) => onPermissionModeChange(providerId, mode)}
                  options={[
                    { value: "provider-defaults", label: "Provider defaults" },
                    { value: "auto-approve", label: "Full access" },
                    {
                      value: "ask-each-time",
                      label: "Ask for approval",
                      disabled: !askEachTimeAvailable,
                      title: askEachTimeAvailable ? undefined : "This provider does not support live approval replies"
                    }
                  ]}
                />
              }
            />
          );
        })}
        <SettingNote>
          Applies to new chats you start for each provider. Existing chats keep their saved
          permissions, and chats launched by an agent inherit that agent's permissions.
          Provider defaults follows its native CLI
          configuration, including Codex automatic review. Full access requests broad permissions.
          Ask for approval shows native requests in the chat. Plan mode keeps its restrictions.
        </SettingNote>
      </SettingGroup>

      <SettingGroup id="settings-conversation" label="Conversation">
        <SettingRow
          label="Chat detail & verbosity"
          description={CHAT_VERBOSITY_HINTS[chatVerbosity]}
          control={
            <Slider
              ariaLabel="Chat detail & verbosity"
              min={1}
              max={4}
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
        <SettingRow
          label="Goals"
          description="Offer /goal in the composer. A goal keeps a chat working until a separate model judges its condition met."
          control={
            <Toggle ariaLabel="Goals" checked={goalEnabled} onChange={onGoalEnabledChange} />
          }
        />
        {goalEnabled && (
          <SettingRow
            label="Turns a goal may spend"
            description="A goal stops and hands back once it reaches this many evaluated turns."
            control={
              <Slider
                ariaLabel="Turns a goal may spend"
                min={GOAL_MAX_TURNS_MIN}
                max={GOAL_MAX_TURNS_MAX}
                value={goalMaxTurns}
                valueLabel={`${goalMaxTurns} turns`}
                onChange={onGoalMaxTurnsChange}
              />
            }
          />
        )}
        <SettingRow
          label="Revert to a turn"
          description="Offer Revert on a finished turn, restoring the files to how they were before it ran."
          control={
            <Toggle
              ariaLabel="Revert to a turn"
              checked={revertEnabled}
              onChange={onRevertEnabledChange}
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
