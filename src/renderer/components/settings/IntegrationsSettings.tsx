import { Check, Copy } from "lucide-react";
import type { JSX } from "react";
import type { DetectedIde, IdeId } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { PROVIDER_SETUP, PROVIDER_SETUP_ORDER } from "../../lib/providerSetup.js";
import { RemoteSettings } from "./RemoteSettings.js";
import { SectionHeader, SettingsListPicker } from "./settingsPrimitives.js";

export function IntegrationsSettings({
  detectedIdes,
  defaultIde,
  onDefaultIdeChange
}: {
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
}): JSX.Element {
  return (
    <>
      <section className="settings-section" id="settings-tools" aria-labelledby="settings-tools-h">
        <SectionHeader
          id="settings-tools-h"
          eyebrow="Editor handoff"
          title="Default IDE"
          description='Pick the editor that opens when you click the "Open in IDE" button on a session.'
        />
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-default-ide">Default IDE</label>
            <SettingsListPicker
              ariaLabel="Default IDE"
              inputId="settings-default-ide"
              // A default that isn't detected (e.g. the factory Cursor default
              // on a machine without Cursor) shows as "Ask each time" — the
              // effective behavior — instead of a dangling option.
              value={defaultIde && detectedIdes.some((entry) => entry.id === defaultIde) ? defaultIde : ""}
              onChange={(next) => {
                onDefaultIdeChange(next === "" ? null : next);
              }}
              disabled={detectedIdes.length === 0}
              placement="above"
              options={[
                { value: "", label: "Ask each time" },
                ...detectedIdes.map((entry) => ({ value: entry.id, label: entry.label }))
              ]}
            />
          </div>
          {detectedIdes.length === 0 ? (
            <p className="settings-hint">
              No supported IDEs detected. Install VS Code, Cursor, Windsurf, or Zed to enable this.
            </p>
          ) : null}
        </div>
      </section>

      <section className="settings-section" id="settings-mcp" aria-labelledby="settings-mcp-h">
        <SectionHeader
          id="settings-mcp-h"
          eyebrow="Model Context Protocol"
          title="MCP servers"
          description="Each agent loads its own MCP configuration when launched by Argmax. Servers are added and authenticated with the provider's CLI or settings."
        />
        <div className="settings-mcp-body">
          {PROVIDER_SETUP_ORDER.map((providerId) => {
            const setup = PROVIDER_SETUP[providerId];
            return (
              <div key={providerId} className="settings-mcp-client">
                <div className="settings-mcp-client-header">
                  <div className="settings-mcp-client-heading">
                    <span className="settings-mcp-client-name">{setup.displayName}</span>
                    <code>{setup.mcpCommand ?? "Settings → Tools & MCP"}</code>
                  </div>
                  {setup.mcpCommand ? <CopyCommandButton command={setup.mcpCommand} name={setup.displayName} /> : null}
                </div>
                <p className="settings-hint">{setup.mcpHint}</p>
              </div>
            );
          })}
        </div>
      </section>

      <RemoteSettings />
    </>
  );
}

function CopyCommandButton({ command, name }: { command: string; name: string }): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();
  return (
    <button
      type="button"
      className="settings-refresh"
      onClick={() => void copy(command)}
      aria-label={`Copy ${name} MCP command`}
    >
      {copyFlash === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <span>{copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy"}</span>
    </button>
  );
}
