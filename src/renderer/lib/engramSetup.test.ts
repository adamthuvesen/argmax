import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { engramDirectoryError, engramSetup } from "./engramSetup.js";

describe("engramDirectoryError", () => {
  it("requires an absolute POSIX path", () => {
    expect(engramDirectoryError("")).toBe("Enter the absolute path to your Engram directory.");
    expect(engramDirectoryError("relative/engram")).toBe("Enter an absolute path beginning with /.");
    expect(engramDirectoryError(" ~/engram")).toBe("Enter an absolute path beginning with /.");
    expect(engramDirectoryError("/Users/me/engram")).toBeNull();
    expect(() => engramSetup("claude", "")).toThrow("Enter the absolute path to your Engram directory.");
    expect(() => engramSetup("claude", "relative/engram")).toThrow("Enter an absolute path beginning with /.");
  });

  it.each(["/tmp/engram\nother", "/tmp/engram\rother", "/tmp/engram\0other", "/tmp/engram\u007fother"])(
    "rejects control characters in %j",
    (directory) => {
      expect(engramDirectoryError(directory)).toBe("The Engram directory cannot contain control characters.");
      expect(() => engramSetup("codex", directory)).toThrow(
        "The Engram directory cannot contain control characters."
      );
    }
  );
});

describe("engramSetup", () => {
  it.each([
    ["claude", "claude mcp add --scope user engram --"],
    ["codex", "codex mcp add engram --"],
    ["grok", "grok mcp add --scope user engram --"]
  ] as const)("builds the %s user-level command", (provider, prefix) => {
    const setup = engramSetup(provider, "/Users/me/Engram repo");

    expect(setup.kind).toBe("command");
    expect(setup.content).toBe(`${prefix} uv run --directory '/Users/me/Engram repo' engram`);
    expect(setup.instructions).toContain("user configuration for all projects");
  });

  it("shell-quotes the literal directory without interpreting shell syntax", () => {
    const directory = "/tmp/Engram's $HOME $(printf injected) `printf injected`";
    const content = engramSetup("codex", directory).content;
    const prefix = "codex mcp add engram -- uv run --directory ";
    const suffix = " engram";
    const quotedDirectory = content.slice(prefix.length, -suffix.length);

    expect(execFileSync("/bin/sh", ["-c", `printf '%s' ${quotedDirectory}`], { encoding: "utf8" })).toBe(
      directory
    );
  });

  it("builds the Cursor MCP JSON entry", () => {
    const setup = engramSetup("cursor", "/Users/me/Engram repo");

    expect(setup.kind).toBe("json");
    expect(JSON.parse(setup.content)).toEqual({
      mcpServers: {
        engram: {
          command: "uv",
          args: ["run", "--directory", "/Users/me/Engram repo", "engram"]
        }
      }
    });
    expect(setup.instructions).toContain("~/.cursor/mcp.json");
    expect(setup.instructions).toContain("preserving the other mcpServers entries");
  });

  it("builds the OpenCode local MCP JSON entry", () => {
    const setup = engramSetup("opencode", "/Users/me/Engram repo");

    expect(setup.kind).toBe("json");
    expect(JSON.parse(setup.content)).toEqual({
      mcp: {
        engram: {
          type: "local",
          command: ["uv", "run", "--directory", "/Users/me/Engram repo", "engram"],
          enabled: true
        }
      }
    });
    expect(setup.instructions).toContain("~/.config/opencode/opencode.json");
    expect(setup.instructions).toContain("preserving the other mcp entries");
  });

  it("does not trim the directory", () => {
    const directory = "/Users/me/engram ";

    expect(JSON.parse(engramSetup("cursor", directory).content)).toEqual({
      mcpServers: {
        engram: {
          command: "uv",
          args: ["run", "--directory", directory, "engram"]
        }
      }
    });
  });
});
