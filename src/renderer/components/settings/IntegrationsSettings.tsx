import { Check, Copy } from "lucide-react";
import { useState, type JSX } from "react";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";
import type { ProviderId } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../../lib/providerSetup.js";
import { ConnectionCatalog } from "../ConnectionCatalog.js";
import { RemoteSettings } from "./RemoteSettings.js";
import { SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

export function IntegrationsSettings(): JSX.Element {
  const [provider, setProvider] = useState<ProviderId>("claude");
  const setup = PROVIDER_SETUP[provider];
  return (
    <>
      <SettingGroup id="settings-mcp" label="Connections">
        <SettingNote>
          MCP servers, plugins, and provider connectors available to each agent. Authentication is
          checked by the provider when it exposes that status.
        </SettingNote>
        <div className="connection-provider-tabs" role="tablist" aria-label="Connection provider">
          {PROVIDER_SETUP_ORDER.map((providerId) => (
            <button
              type="button"
              role="tab"
              aria-selected={provider === providerId}
              key={providerId}
              onClick={() => setProvider(providerId)}
            >
              {PROVIDER_DISPLAY_NAMES[providerId]}
            </button>
          ))}
        </div>
        <ConnectionCatalog key={provider} provider={provider} />
        <SettingRow
          label={`Add to ${setup.displayName}`}
          description={<code className="settings-row-code">{setup.mcpCommand ?? "Settings → Tools & MCP"}</code>}
          control={
            setup.mcpCommand ? (
              <CopyCommandButton command={setup.mcpCommand} name={setup.displayName} />
            ) : null
          }
        />
      </SettingGroup>

      <RemoteSettings />
    </>
  );
}

function CopyCommandButton({ command, name }: { command: string; name: string }): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();
  return (
    <button
      type="button"
      className="settings-button"
      onClick={() => void copy(command)}
      aria-label={`Copy ${name} MCP command`}
    >
      {copyFlash === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <span>{copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy"}</span>
    </button>
  );
}
