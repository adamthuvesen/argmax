import type { JSX } from "react";
import type { DetectedIde, IdeId } from "../../../shared/types.js";
import { SectionHeader, SettingsListPicker } from "./settingsPrimitives.js";

const MCP_SETUP = [
  {
    name: "Claude Code",
    command: "claude mcp add <name> -- <command>",
    detail: "Servers are managed with the Claude CLI or ~/.claude.json. Authentication is opened with /mcp inside Claude."
  },
  {
    name: "Codex",
    command: "codex mcp add <name> -- <command>",
    detail: "Servers are managed with the Codex CLI or ~/.codex/config.toml."
  },
  {
    name: "Cursor",
    command: "Settings → Tools & MCP",
    detail: "Servers are managed in Cursor settings or ~/.cursor/mcp.json."
  }
] as const;

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
              value={defaultIde ?? ""}
              onChange={(next) => {
                onDefaultIdeChange(next === "" ? null : next);
              }}
              disabled={detectedIdes.length === 0}
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
          {MCP_SETUP.map((provider) => (
            <div key={provider.name} className="settings-mcp-client">
              <div className="settings-mcp-client-header">
                <div className="settings-mcp-client-heading">
                  <span className="settings-mcp-client-name">{provider.name}</span>
                  <code>{provider.command}</code>
                </div>
              </div>
              <p className="settings-hint">{provider.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
