import { FolderOpen, Key, RefreshCcw } from "lucide-react";
import type { JSX } from "react";
import type { DetectedIde, IdeId, McpClientListing } from "../../../shared/types.js";
import { SectionHeader } from "./settingsPrimitives.js";

const MCP_TRANSPORT_LABELS: Record<string, string> = {
  stdio: "stdio",
  http: "http",
  sse: "sse",
  unknown: "unknown"
};

const MCP_CLIENT_HINTS: Record<string, string> = {
  claude: "Configured via the `claude mcp add` CLI or by editing `~/.claude.json`.",
  codex: "Configured under `[mcp_servers.NAME]` in `~/.codex/config.toml`.",
  cursor: "Configured via Cursor's MCP settings or by editing `~/.cursor/mcp.json`."
};

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
            <select
              id="settings-default-ide"
              aria-label="Default IDE"
              className="settings-select"
              value={defaultIde ?? ""}
              onChange={(event) => {
                const next = event.target.value;
                onDefaultIdeChange(next === "" ? null : (next as IdeId));
              }}
              disabled={detectedIdes.length === 0}
            >
              <option value="">Ask each time</option>
              {detectedIdes.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
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
              MCP servers configured for each CLI. Argmax reads the user-scope config files.
              For Claude Code, click <em>Authenticate</em> to run <code>/mcp</code> in-app;
              Codex and Cursor don’t expose a CLI auth flow, so edit their config files
              directly to manage credentials.
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
            mcpListings.map((listing) => (
              <div key={listing.client} className="settings-mcp-client">
                <div className="settings-mcp-client-header">
                  <span className="settings-mcp-client-name">{listing.displayName}</span>
                  <span className="settings-mcp-client-count">
                    {listing.configExists
                      ? `${listing.servers.length} ${listing.servers.length === 1 ? "server" : "servers"}`
                      : "No config file"}
                  </span>
                  {listing.client === "claude" ? (
                    <button
                      type="button"
                      className="settings-mcp-auth"
                      onClick={onMcpAuthOpen}
                      aria-label="Authenticate Claude MCP servers"
                      title="Run `claude` and open the /mcp auth picker"
                    >
                      <Key size={12} aria-hidden="true" />
                      <span>Authenticate via Claude (/mcp)</span>
                    </button>
                  ) : null}
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
                    {listing.configPath
                      ? `Argmax checked ${listing.configPath} — not found yet. ${MCP_CLIENT_HINTS[listing.client] ?? ""}`
                      : MCP_CLIENT_HINTS[listing.client]}
                  </p>
                ) : null}
                {listing.servers.length > 0 ? (
                  <ul className="settings-mcp-server-list">
                    {listing.servers.map((server) => {
                      const detail = server.url ?? server.command ?? "";
                      return (
                        <li key={`${listing.client}:${server.name}`} className="settings-mcp-server-row">
                          <div className="settings-mcp-server-meta">
                            <div className="settings-mcp-server-line">
                              <span className="settings-mcp-server-name">{server.name}</span>
                              <span
                                className="settings-mcp-server-badge"
                                data-transport={server.transport}
                                title={`Transport: ${server.transport}`}
                              >
                                {MCP_TRANSPORT_LABELS[server.transport] ?? server.transport}
                              </span>
                            </div>
                            {detail ? (
                              <span className="settings-mcp-server-detail" title={detail}>
                                {detail}
                              </span>
                            ) : null}
                            {server.envKeys.length > 0 ? (
                              <span className="settings-mcp-server-envs">
                                env: {server.envKeys.join(", ")}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {listing.configPath ? (
                  <button
                    type="button"
                    className="settings-mcp-config-link"
                    onClick={() => void revealMcpConfig(listing.configPath as string)}
                    title={listing.configPath}
                  >
                    <FolderOpen size={12} aria-hidden="true" />
                    <span>Reveal config</span>
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="settings-hint">Reading MCP configs…</p>
          )}
        </div>
      </section>
    </>
  );
}
