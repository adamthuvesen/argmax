import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  McpClientListing,
  McpServerEntry,
  McpTransport,
  ProviderId
} from "../../shared/types.js";

/**
 * MCP server registry — discovers user-scope MCP servers configured for each
 * CLI client Argmax launches (Claude Code, Codex, Cursor). The goal is the
 * Settings → MCP servers list: "what would this CLI try to connect to if I
 * launched it right now?" Project-scoped overrides (`<repo>/.mcp.json`,
 * `<repo>/.cursor/mcp.json`, Claude's per-project `mcpServers` map under
 * `~/.claude.json`'s `projects` key) are intentionally out of scope for the
 * first pass — the global Settings view is user-scope only.
 *
 * Config files read:
 *   claude:  ~/.claude.json (top-level `mcpServers`)
 *   codex:   ~/.codex/config.toml (every `[mcp_servers.NAME]` table)
 *   cursor:  ~/.cursor/mcp.json (top-level `mcpServers`)
 *
 * Each client returns a listing even when its config file is missing — the
 * UI distinguishes "no config" from "empty config" from "parse error" via
 * `configExists` and `error`. None of the read paths throw; a missing file
 * is the normal initial state.
 */

export const MCP_CLIENT_DISPLAY_NAMES: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor"
};

export async function listMcpServers(home: string = homedir()): Promise<McpClientListing[]> {
  const [claude, codex, cursor] = await Promise.all([
    listClaudeMcp(home),
    listCodexMcp(home),
    listCursorMcp(home)
  ]);
  return [claude, codex, cursor];
}

// ---------------------------------------------------------------------------
// Claude — ~/.claude.json, top-level `mcpServers` map
// ---------------------------------------------------------------------------

async function listClaudeMcp(home: string): Promise<McpClientListing> {
  const configPath = join(home, ".claude.json");
  const raw = await safeReadFile(configPath);
  if (raw === null) {
    return baseListing("claude", configPath, false);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const servers = extractJsonMcpServers(parsed, "claude", configPath);
    return { ...baseListing("claude", configPath, true), servers };
  } catch (error) {
    return {
      ...baseListing("claude", configPath, true),
      error: error instanceof Error ? error.message : "Could not parse ~/.claude.json"
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor — ~/.cursor/mcp.json, top-level `mcpServers` map
// ---------------------------------------------------------------------------

async function listCursorMcp(home: string): Promise<McpClientListing> {
  const configPath = join(home, ".cursor", "mcp.json");
  const raw = await safeReadFile(configPath);
  if (raw === null) {
    return baseListing("cursor", configPath, false);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const servers = extractJsonMcpServers(parsed, "cursor", configPath);
    return { ...baseListing("cursor", configPath, true), servers };
  } catch (error) {
    return {
      ...baseListing("cursor", configPath, true),
      error: error instanceof Error ? error.message : "Could not parse ~/.cursor/mcp.json"
    };
  }
}

function extractJsonMcpServers(
  parsed: unknown,
  client: ProviderId,
  configPath: string
): McpServerEntry[] {
  if (!parsed || typeof parsed !== "object") return [];
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") return [];

  const entries: McpServerEntry[] = [];
  for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const spec = raw as Record<string, unknown>;
    const url = typeof spec.url === "string" ? spec.url : null;
    const command = typeof spec.command === "string" ? spec.command : null;
    const explicitType = typeof spec.type === "string" ? spec.type.toLowerCase() : null;
    const transport = classifyTransport(explicitType, command, url);
    const envKeys = spec.env && typeof spec.env === "object" ? Object.keys(spec.env) : [];
    entries.push({
      client,
      name,
      transport,
      scope: "user",
      source: configPath,
      command: command ?? undefined,
      url: url ?? undefined,
      envKeys
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/config.toml, every `[mcp_servers.NAME]` table
// ---------------------------------------------------------------------------

async function listCodexMcp(home: string): Promise<McpClientListing> {
  const configPath = join(home, ".codex", "config.toml");
  const raw = await safeReadFile(configPath);
  if (raw === null) {
    return baseListing("codex", configPath, false);
  }
  try {
    const servers = parseCodexMcpTables(raw, configPath);
    return { ...baseListing("codex", configPath, true), servers };
  } catch (error) {
    return {
      ...baseListing("codex", configPath, true),
      error: error instanceof Error ? error.message : "Could not parse ~/.codex/config.toml"
    };
  }
}

/**
 * Focused TOML reader: collects `[mcp_servers.NAME]` and
 * `[mcp_servers.NAME.env]` tables from a Codex config and pulls out the
 * three fields we care about (command, url, env keys). It is NOT a general
 * TOML parser — array values, comments, and quoted-string keys are handled
 * just enough for typical Codex configs. Anything outside `mcp_servers.*` is
 * ignored.
 */
export function parseCodexMcpTables(content: string, source: string): McpServerEntry[] {
  const lines = content.split(/\r?\n/);
  const servers = new Map<string, { command: string | null; url: string | null; envKeys: string[] }>();
  type Section = { kind: "ignore" } | { kind: "server"; name: string } | { kind: "env"; name: string };
  let section: Section = { kind: "ignore" };
  // While we are inside a multi-line array value, ignore content lines until
  // we hit the closing `]`. We don't need the values — just need to avoid
  // misreading e.g. `command = "..."` that appears inside a string in the
  // array. For our minimal needs, skipping over the array is enough.
  let inArray = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const stripped = stripTomlComment(rawLine).trim();
    if (!stripped) continue;

    if (inArray) {
      if (stripped.includes("]")) inArray = false;
      continue;
    }

    const header = matchTableHeader(stripped);
    if (header) {
      const mcpMatch = /^mcp_servers\.([^.]+)(?:\.(.+))?$/.exec(header);
      if (!mcpMatch) {
        section = { kind: "ignore" };
        continue;
      }
      const name = unquoteTomlKey(mcpMatch[1] ?? "");
      const sub = mcpMatch[2];
      if (!name) {
        section = { kind: "ignore" };
        continue;
      }
      if (!servers.has(name)) {
        servers.set(name, { command: null, url: null, envKeys: [] });
      }
      section = sub === "env" ? { kind: "env", name } : sub ? { kind: "ignore" } : { kind: "server", name };
      continue;
    }

    if (section.kind === "ignore") {
      if (stripped.endsWith("[") || /=\s*\[\s*$/.test(stripped)) {
        inArray = true;
      }
      continue;
    }

    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    const value = stripped.slice(eq + 1).trim();

    if (section.kind === "env") {
      const entry = servers.get(section.name);
      if (entry && key) entry.envKeys.push(unquoteTomlKey(key));
      continue;
    }

    const entry = servers.get(section.name);
    if (!entry) continue;

    if (key === "command") {
      const parsedValue = parseTomlScalar(value);
      if (typeof parsedValue === "string") entry.command = parsedValue;
    } else if (key === "url") {
      const parsedValue = parseTomlScalar(value);
      if (typeof parsedValue === "string") entry.url = parsedValue;
    } else if (value.startsWith("[") && !value.endsWith("]")) {
      // Multi-line array; skip its body.
      inArray = true;
    }
  }

  const out: McpServerEntry[] = [];
  for (const [name, data] of servers.entries()) {
    out.push({
      client: "codex",
      name,
      transport: classifyTransport(null, data.command, data.url),
      scope: "user",
      source,
      command: data.command ?? undefined,
      url: data.url ?? undefined,
      envKeys: data.envKeys
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function matchTableHeader(line: string): string | null {
  if (!line.startsWith("[") || line.startsWith("[[")) return null;
  const end = line.indexOf("]");
  if (end === -1) return null;
  return line.slice(1, end).trim();
}

function stripTomlComment(line: string): string {
  // Strip `#` and anything after, but only when not inside a string. For our
  // scope we accept the small risk of `#` inside a string value being treated
  // as a comment — it doesn't appear in known Codex MCP configs.
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inDouble && !inSingle) return line.slice(0, i);
  }
  return line;
}

function unquoteTomlKey(key: string): string {
  const trimmed = key.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlScalar(value: string): string | number | boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyTransport(
  explicitType: string | null,
  command: string | null,
  url: string | null
): McpTransport {
  if (explicitType === "stdio") return "stdio";
  if (explicitType === "http") return "http";
  if (explicitType === "sse") return "sse";
  if (url) return "http";
  if (command) return "stdio";
  return "unknown";
}

function baseListing(
  client: ProviderId,
  configPath: string,
  configExists: boolean
): McpClientListing {
  return {
    client,
    displayName: MCP_CLIENT_DISPLAY_NAMES[client],
    configPath,
    configExists,
    servers: [],
    error: null
  };
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
