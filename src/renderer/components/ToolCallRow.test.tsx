import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../lib/toolCalls.js";
import type * as CommandIcons from "../lib/commandIcons.js";
import { ToolCallRow } from "./ToolCallRow.js";

vi.mock("../lib/commandIcons.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CommandIcons>();
  return {
    ...actual,
    commandIconServer: (call: ToolCall) => actual.commandIconServer(call, [
      { commandPattern: "^run_only_sql(?:\\s|$)", server: "snowflake" }
    ])
  };
});

afterEach(() => {
  cleanup();
});

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    toolUseId: "tool-use-1",
    name: "Bash",
    inputPreview: "mkdir -p dist",
    inputFull: { command: "mkdir -p dist" },
    output: null,
    status: "done",
    createdAt: "2026-05-30T12:00:00.000Z",
    completedAt: "2026-05-30T12:00:01.000Z",
    error: null,
    ...overrides
  };
}

describe("ToolCallRow", () => {
  it.each(["running", "error"] as const)("keeps %s tool failures collapsed until opened", (status) => {
    const failed = tool({ status: "error", error: "Permission denied" });
    const { rerender } = render(<ToolCallRow tool={tool({ status })} />);
    rerender(<ToolCallRow tool={failed} />);

    const row = screen.getByRole("button", { name: "Ran mkdir -p dist" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Permission denied")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByText("Permission denied")).not.toBeInTheDocument();
  });

  it("marks a built-in web row with the globe though it has no MCP server", () => {
    render(<ToolCallRow tool={tool({ name: "WebSearch", inputPreview: "tauri 2 webview" })} />);

    expect(screen.getByRole("img", { name: "Web" })).toBeInTheDocument();
  });

  it("leaves a local row unmarked", () => {
    render(<ToolCallRow tool={tool()} />);

    expect(screen.queryByRole("img", { name: "Web" })).toBeNull();
  });

  it("does not offer a disclosure when expanding would show nothing", () => {
    render(<ToolCallRow tool={tool()} />);

    expect(screen.getByText("mkdir -p dist")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ran mkdir -p dist" })).toBeNull();
  });

  it("keeps a bash row expandable when it printed output", () => {
    render(
      <ToolCallRow
        tool={tool({
          inputPreview: "echo ok",
          inputFull: { command: "echo ok" },
          output: "ok"
        })}
      />
    );

    const row = screen.getByRole("button", { name: "Ran echo ok" });
    expect(row).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("keeps a file read expandable so Open is reachable", () => {
    render(
      <ToolCallRow
        tool={tool({
          name: "Read",
          inputPreview: "README.md",
          inputFull: { file_path: "/repo/README.md" },
          output: null
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Read README.md" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});

describe("ToolCallRow server marks", () => {
  afterEach(() => cleanup());

  it("shows a configured brand mark on a shell script row", () => {
    render(<ToolCallRow tool={tool({ inputFull: { command: "run_only_sql" } })} />);
    expect(screen.getByRole("img", { name: "Snowflake" })).toBeInTheDocument();
  });

  it("updates the mark when full input arrives with the same preview", () => {
    const { rerender } = render(<ToolCallRow tool={tool()} />);
    expect(screen.queryByRole("img", { name: "Snowflake" })).toBeNull();
    rerender(<ToolCallRow tool={tool({ inputFull: { command: "run_only_sql" } })} />);
    expect(screen.getByRole("img", { name: "Snowflake" })).toBeInTheDocument();
  });

  it("updates a nested mark when child input arrives with the same preview", () => {
    const parent = tool({ id: "parent", name: "Task", inputPreview: "Query data" });
    const { rerender } = render(<ToolCallRow tool={parent} childTools={[tool()]} defaultExpanded />);
    expect(screen.queryByRole("img", { name: "Snowflake" })).toBeNull();
    rerender(<ToolCallRow tool={parent} childTools={[tool({ inputFull: { command: "run_only_sql" } })]} defaultExpanded />);
    expect(screen.getByRole("img", { name: "Snowflake" })).toBeInTheDocument();
  });

  it("leads an MCP row with the server's brand mark", () => {
    render(
      <ToolCallRow
        tool={tool({
          name: "mcp__claude_ai_Slack__slack_search_public",
          inputPreview: "PQL score",
          inputFull: { query: "PQL score" }
        })}
      />
    );
    expect(screen.getByRole("img", { name: "Slack" })).toBeInTheDocument();
  });

  it("shows no mark on a built-in tool row", () => {
    render(<ToolCallRow tool={tool()} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
