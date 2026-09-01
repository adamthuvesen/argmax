import type { ProviderId } from "../../shared/types.js";

/**
 * Per-provider setup commands surfaced during onboarding (WelcomePane) and in
 * Settings → Integrations. Install/login commands mirror each provider's
 * current docs; login commands match the guidance strings produced by
 * `src-tauri/src/providers/discovery.rs`.
 *
 * MCP is configured through each provider's own CLI or settings — Argmax
 * launches the CLI with the user's existing config, so servers added there
 * appear in Argmax sessions automatically (see docs/providers.md).
 */
export type ProviderSetup = {
  displayName: string;
  installCommand: string;
  loginCommand: string;
  /** Null when the provider configures MCP through a settings UI, not a command. */
  mcpCommand: string | null;
  mcpHint: string;
};

export const PROVIDER_SETUP_ORDER: readonly ProviderId[] = ["claude", "codex", "cursor", "opencode", "grok"];

export const PROVIDER_SETUP: Record<ProviderId, ProviderSetup> = {
  claude: {
    displayName: "Claude Code",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    loginCommand: "claude auth login",
    mcpCommand: "claude mcp add <name> -- <command>",
    mcpHint: "Servers are managed with the Claude CLI or ~/.claude.json. Authentication is opened with /mcp inside Claude."
  },
  codex: {
    displayName: "Codex",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    mcpCommand: "codex mcp add <name> -- <command>",
    mcpHint: "Servers are managed with the Codex CLI or ~/.codex/config.toml."
  },
  cursor: {
    displayName: "Cursor",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    loginCommand: "cursor-agent login",
    mcpCommand: null,
    mcpHint: "Servers are managed under Settings → Tools & MCP in Cursor, or in ~/.cursor/mcp.json."
  },
  opencode: {
    displayName: "OpenCode",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    loginCommand: "opencode auth login",
    mcpCommand: "opencode mcp add",
    mcpHint: "Servers are managed with the OpenCode CLI or ~/.config/opencode/opencode.json."
  },
  grok: {
    displayName: "Grok Build",
    installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
    loginCommand: "grok login",
    mcpCommand: "grok mcp add <name> -- <command>",
    mcpHint: "Servers are managed with the Grok CLI or ~/.grok/config.toml."
  }
};
