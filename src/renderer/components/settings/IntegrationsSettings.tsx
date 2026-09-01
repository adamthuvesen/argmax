import { Check, Copy } from "lucide-react";
import type { JSX } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../../lib/providerSetup.js";
import { RemoteSettings } from "./RemoteSettings.js";
import { SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

export function IntegrationsSettings(): JSX.Element {
  return (
    <>
      <SettingGroup id="settings-mcp" label="MCP servers">
        <SettingNote>
          Each agent loads its own MCP configuration when Argmax launches it. Add and authenticate
          servers with the provider's own CLI or settings.
        </SettingNote>
        {PROVIDER_SETUP_ORDER.map((providerId) => {
          const setup = PROVIDER_SETUP[providerId];
          return (
            <SettingRow
              key={providerId}
              label={setup.displayName}
              description={<code className="settings-row-code">{setup.mcpCommand ?? "Settings → Tools & MCP"}</code>}
              control={
                setup.mcpCommand ? (
                  <CopyCommandButton command={setup.mcpCommand} name={setup.displayName} />
                ) : null
              }
            />
          );
        })}
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
