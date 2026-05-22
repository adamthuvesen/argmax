import type { ProviderId } from "../../shared/types.js";

export const PROVIDER_INSTALL_HINTS: Record<ProviderId, { label: string; url: string }> = {
  claude: {
    label: "Install Claude Code CLI",
    url: "https://docs.claude.com/en/docs/claude-code/install"
  },
  codex: {
    label: "Install Codex CLI",
    url: "https://github.com/openai/codex"
  },
  cursor: {
    label: "Install Cursor CLI",
    url: "https://cursor.com/cli"
  }
};
