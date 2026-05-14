// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMcpServers, parseCodexMcpTables } from "../mcpRegistry.js";

describe("parseCodexMcpTables", () => {
  it("extracts every [mcp_servers.NAME] table and classifies transport from command vs url", () => {
    const toml = `
# unrelated config
model = "gpt"
[features]
hooks = true

[mcp_servers.trace]
command = "uv"
args = [
  "run",
  "--directory",
  "/tmp/trace",
  "trace",
]
default_tools_approval_mode = "approve"
[mcp_servers.trace.env]
KB_COLLECTIONS = "wiki:/tmp/wiki"
LOG_LEVEL = "INFO"

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
default_tools_approval_mode = "approve"
`;
    const result = parseCodexMcpTables(toml, "/x/config.toml");
    expect(result.map((r) => r.name)).toEqual(["context7", "linear", "trace"]);
    const trace = result.find((r) => r.name === "trace");
    expect(trace?.transport).toBe("stdio");
    expect(trace?.command).toBe("uv");
    expect(trace?.url).toBeUndefined();
    expect(trace?.envKeys.sort()).toEqual(["KB_COLLECTIONS", "LOG_LEVEL"]);
    const context7 = result.find((r) => r.name === "context7");
    expect(context7?.transport).toBe("http");
    expect(context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(context7?.command).toBeUndefined();
  });

  it("ignores non-mcp tables and tolerates inline arrays without leaking into the next table", () => {
    const toml = `
[mcp_servers.a]
command = "x"
args = ["one", "two"]

[mcp_servers.b]
url = "https://example.com"
`;
    const result = parseCodexMcpTables(toml, "/x/config.toml");
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === "a")?.transport).toBe("stdio");
    expect(result.find((r) => r.name === "b")?.transport).toBe("http");
  });

  it("returns unknown transport when neither command nor url is set", () => {
    const toml = `
[mcp_servers.weird]
some_field = "x"
`;
    const result = parseCodexMcpTables(toml, "/x/config.toml");
    expect(result).toHaveLength(1);
    expect(result[0]?.transport).toBe("unknown");
  });

  it("strips comments and tolerates blank/whitespace lines", () => {
    const toml = `
# top comment

[mcp_servers.x] # inline comment after header
command = "x" # trailing comment
`;
    const result = parseCodexMcpTables(toml, "/x/config.toml");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("x");
    expect(result[0]?.command).toBe("x");
  });
});

describe("listMcpServers", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "argmax-mcp-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("returns one listing per client even when no config files exist", async () => {
    const listings = await listMcpServers(tempHome);
    expect(listings.map((l) => l.client)).toEqual(["claude", "codex", "cursor"]);
    for (const listing of listings) {
      expect(listing.configExists).toBe(false);
      expect(listing.servers).toEqual([]);
      expect(listing.error).toBeNull();
    }
  });

  it("reads Claude mcpServers from ~/.claude.json and classifies transport from `type` over command", async () => {
    await writeFile(
      join(tempHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "stdio-one": { type: "stdio", command: "x", args: ["a"], env: { FOO: "1", BAR: "2" } },
          "http-one": { type: "http", url: "https://example.com" },
          "infer-stdio": { command: "y" },
          "infer-http": { url: "https://z.example.com" }
        }
      })
    );
    const listings = await listMcpServers(tempHome);
    const claude = listings.find((l) => l.client === "claude");
    expect(claude?.configExists).toBe(true);
    expect(claude?.servers.map((s) => s.name)).toEqual(["http-one", "infer-http", "infer-stdio", "stdio-one"]);
    const stdioOne = claude?.servers.find((s) => s.name === "stdio-one");
    expect(stdioOne?.transport).toBe("stdio");
    expect(stdioOne?.command).toBe("x");
    expect(stdioOne?.envKeys.sort()).toEqual(["BAR", "FOO"]);
    expect(claude?.servers.find((s) => s.name === "http-one")?.transport).toBe("http");
    expect(claude?.servers.find((s) => s.name === "infer-stdio")?.transport).toBe("stdio");
    expect(claude?.servers.find((s) => s.name === "infer-http")?.transport).toBe("http");
  });

  it("reads Cursor mcpServers from ~/.cursor/mcp.json (including via symlink)", async () => {
    const realCursor = join(tempHome, "real-cursor.json");
    await writeFile(
      realCursor,
      JSON.stringify({
        mcpServers: {
          slack: { type: "http", url: "https://mcp.slack.com/mcp" }
        }
      })
    );
    await mkdir(join(tempHome, ".cursor"), { recursive: true });
    await symlink(realCursor, join(tempHome, ".cursor", "mcp.json"));
    const listings = await listMcpServers(tempHome);
    const cursor = listings.find((l) => l.client === "cursor");
    expect(cursor?.configExists).toBe(true);
    expect(cursor?.servers).toHaveLength(1);
    expect(cursor?.servers[0]?.name).toBe("slack");
    expect(cursor?.servers[0]?.transport).toBe("http");
  });

  it("surfaces a parse error instead of throwing when config is malformed", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{not json");
    const listings = await listMcpServers(tempHome);
    const claude = listings.find((l) => l.client === "claude");
    expect(claude?.configExists).toBe(true);
    expect(claude?.error).toBeTruthy();
    expect(claude?.servers).toEqual([]);
  });
});
