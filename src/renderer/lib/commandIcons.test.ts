import { describe, expect, it } from "vitest";
import { commandIconServer, DEFAULT_RULES, parseCommandIconRules } from "./commandIcons.js";
import type { ToolCall } from "./toolCalls.js";

const rules = parseCommandIconRules([{
  commandPattern: "^(?:uv\\s+run\\s+)?(?:python(?:3(?:\\.\\d+)?)?\\s+)?[\"']?(?:[^\\s\"']*/)?run_(?:only_sql|readonly_sql)(?:\\.py)?[\"']?(?=\\s|$)",
  server: "snowflake"
}]);

function tool(command: string, name = "Bash", key = "command"): ToolCall {
  return {
    id: "sql", toolUseId: "sql", name, inputFull: { [key]: command },
    inputPreview: command.slice(0, 72), output: null, status: "done",
    createdAt: "2026-09-07T10:00:00Z", completedAt: null, error: null
  };
}

describe("command icons", () => {
  it.each([
    "run_only_sql --query 'select 1'",
    'uv run python "$HOME/.agents/skills/snow/scripts/run_readonly_sql.py" <<\'SQL\'\nselect 1\nSQL',
    '/bin/zsh -lc "uv run python /a/very/long/path/to/the/personal/snowflake/skill/scripts/run_readonly_sql.py"'
  ])("recognizes the configured script in %s", (command) => {
    expect(commandIconServer(tool(command), rules)).toBe("snowflake");
  });

  it.each(["command", "cmd", "shell_command", "script"])("reads the full %s field", (key) => {
    expect(commandIconServer(tool("run_only_sql", "exec_command", key), rules)).toBe("snowflake");
  });

  it.each(["echo run_only_sql", "cat run_only_sql.py", "run_only_sql_backup", "python other.py", "echo ok\nrun_only_sql"])("does not match %s", (command) => {
    expect(commandIconServer(tool(command), rules)).toBeNull();
  });

  it.each([
    "gh pr create --fill",
    "gh run watch 42",
    "/opt/homebrew/bin/gh pr view 1158 --json state",
    "zsh -lc 'gh auth status'"
  ])("marks the GitHub CLI in %s by default", (command) => {
    expect(commandIconServer(tool(command), DEFAULT_RULES)).toBe("github");
  });

  it.each(["git push", "ghost --help", "echo gh pr create"])("leaves %s unmarked", (command) => {
    expect(commandIconServer(tool(command), DEFAULT_RULES)).toBeNull();
  });

  it("leaves public defaults and non-shell tools alone", () => {
    expect(commandIconServer(tool("run_only_sql"), [])).toBeNull();
    expect(commandIconServer(tool("run_only_sql", "Read"), rules)).toBeNull();
  });

  it.each([{}, [{ commandPattern: "[", server: "snowflake" }], [{ commandPattern: "", server: "snowflake" }], [{ commandPattern: "sql", server: "unknown" }], [{ commandPattern: "sql", server: "constructor" }], [{ commandPattern: "sql", server: "snowflake", typo: true }]])("rejects invalid configuration: %j", (value) => {
    expect(() => parseCommandIconRules(value)).toThrow(/argmax-icons.local.json/);
  });
});
