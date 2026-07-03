import { FolderOpen, Key, RefreshCcw } from "lucide-react";
import type { JSX } from "react";
import type { DetectedIde, IdeId, McpClientListing, McpServerEntry } from "../../../shared/types.js";
import { SectionHeader, SettingsListPicker } from "./settingsPrimitives.js";

const MCP_CLIENT_HINTS: Record<string, string> = {
  claude: "Configured via the `claude mcp add` CLI or by editing `~/.claude.json`.",
  codex: "Configured under `[mcp_servers.NAME]` in `~/.codex/config.toml`.",
  cursor: "Configured via Cursor's MCP settings or by editing `~/.cursor/mcp.json`."
};

function mcpServerDetail(server: McpServerEntry): string {
  const location = server.url ?? server.command ?? "";
  const env = server.envKeys.length > 0 ? `env ${server.envKeys.join(", ")}` : "";
  return [location, env].filter(Boolean).join(" · ");
}

export function IntegrationsSettings({
  detectedIdes,
  defaultIde,
  onDefaultIdeChange,
  mcpListings,
  mcpLoadError,
  refreshingMcp,
  refreshMcp,
  revealMcpConfig,
  onMcpAuthOpen
}: {
  detectedIdes: DetectedIde[];
  defaultIde: IdeId | null;
  onDefaultIdeChange: (ide: IdeId | null) => void;
  mcpListings: McpClientListing[] | null;
  mcpLoadError: string | null;
  refreshingMcp: boolean;
  refreshMcp: () => void;
  revealMcpConfig: (path: string) => Promise<void>;
  onMcpAuthOpen: () => void;
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
          description={
            <>
              Configured servers found in local CLI config files. Claude can authenticate
              in-app; Codex and Cursor use their own config.
            </>
          }
          action={
            <button
              type="button"
              className="settings-refresh"
              onClick={() => void refreshMcp()}
              disabled={refreshingMcp}
              aria-label="Refresh MCP server list"
            >
              <RefreshCcw size={13} aria-hidden="true" className={refreshingMcp ? "is-spinning" : undefined} />
              <span>{refreshingMcp ? "Refreshing…" : "Refresh"}</span>
            </button>
          }
        />
        <div className="settings-mcp-body">
          {mcpLoadError ? (
            <p className="settings-hint" role="alert">
              {mcpLoadError}
            </p>
          ) : null}
          {mcpListings ? (
            mcpListings.map((listing) => {
              const configPath = listing.configPath;
              const serverCount = listing.configExists
                ? `${listing.servers.length} ${listing.servers.length === 1 ? "server" : "servers"}`
                : "No config file";
              return (
                <div key={listing.client} className="settings-mcp-client">
                  <div className="settings-mcp-client-header">
                    <div className="settings-mcp-client-heading">
                      <span className="settings-mcp-client-name">{listing.displayName}</span>
                      <span className="settings-mcp-client-count">{serverCount}</span>
                    </div>
                    <div className="settings-mcp-client-actions">
                      {listing.client === "claude" ? (
                        <button
                          type="button"
                          className="settings-mcp-action settings-mcp-auth"
                          onClick={onMcpAuthOpen}
                          aria-label="Authenticate Claude MCP servers"
                          title="Run Claude and open the MCP auth picker"
                        >
                          <Key size={12} aria-hidden="true" />
                          <span>Authenticate</span>
                        </button>
                      ) : null}
                      {configPath ? (
                        <button
                          type="button"
                          className="settings-mcp-action settings-mcp-config-link"
                          onClick={() => void revealMcpConfig(configPath)}
                          title={configPath}
                        >
                          <FolderOpen size={12} aria-hidden="true" />
                          <span>Reveal config</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {listing.error ? (
                    <p className="settings-hint" role="alert">
                      Couldn’t read this config: {listing.error}
                    </p>
                  ) : null}
                  {listing.configExists && listing.servers.length === 0 && !listing.error ? (
                    <p className="settings-hint">
                      No MCP servers configured. {MCP_CLIENT_HINTS[listing.client]}
                    </p>
                  ) : null}
                  {!listing.configExists ? (
                    <p className="settings-hint">
                      {configPath
                        ? `Argmax checked ${configPath} — not found yet. ${MCP_CLIENT_HINTS[listing.client] ?? ""}`
                        : MCP_CLIENT_HINTS[listing.client]}
                    </p>
                  ) : null}
                  {listing.servers.length > 0 ? (
                    <ul className="settings-mcp-server-list">
                      {listing.servers.map((server) => {
                        const detail = mcpServerDetail(server);
                        return (
                          <li key={`${listing.client}:${server.name}`} className="settings-mcp-server-row">
                            <span className="settings-mcp-server-name">{server.name}</span>
                            {detail ? (
                              <span className="settings-mcp-server-detail" title={detail}>
                                {detail}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="settings-hint">Reading MCP configs…</p>
          )}
        </div>
      </section>
    </>
  );
}
