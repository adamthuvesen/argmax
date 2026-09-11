import type { ProviderId } from "../../shared/types.js";

export type EngramSetup = {
  kind: "command" | "json";
  content: string;
  instructions: string;
};

const COMMAND_INSTRUCTIONS =
  "Run this command in a terminal. It adds Engram to your user configuration for all projects. Then refresh Connections below and start a new chat.";

export function engramDirectoryError(directory: string): string | null {
  if (directory.length === 0) {
    return "Enter the absolute path to your Engram directory.";
  }
  if ([...directory].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  })) {
    return "The Engram directory cannot contain control characters.";
  }
  if (!directory.startsWith("/")) {
    return "Enter an absolute path beginning with /.";
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function engramSetup(provider: ProviderId, directory: string): EngramSetup {
  const error = engramDirectoryError(directory);
  if (error) {
    throw new Error(error);
  }

  const command = `uv run --directory ${shellQuote(directory)} engram`;

  switch (provider) {
    case "claude":
      return {
        kind: "command",
        content: `claude mcp add --scope user engram -- ${command}`,
        instructions: COMMAND_INSTRUCTIONS
      };
    case "codex":
      return {
        kind: "command",
        content: `codex mcp add engram -- ${command}`,
        instructions: COMMAND_INSTRUCTIONS
      };
    case "grok":
      return {
        kind: "command",
        content: `grok mcp add --scope user engram -- ${command}`,
        instructions: COMMAND_INSTRUCTIONS
      };
    case "cursor":
      return {
        kind: "json",
        content: JSON.stringify(
          {
            mcpServers: {
              engram: {
                command: "uv",
                args: ["run", "--directory", directory, "engram"]
              }
            }
          },
          null,
          2
        ),
        instructions:
          "Merge the engram entry into ~/.cursor/mcp.json, preserving the other mcpServers entries. Then refresh Connections below and start a new chat."
      };
    case "opencode":
      return {
        kind: "json",
        content: JSON.stringify(
          {
            mcp: {
              engram: {
                type: "local",
                command: ["uv", "run", "--directory", directory, "engram"],
                enabled: true
              }
            }
          },
          null,
          2
        ),
        instructions:
          "Merge the engram entry into ~/.config/opencode/opencode.json, preserving the other mcp entries. Then refresh Connections below and start a new chat."
      };
  }
}
