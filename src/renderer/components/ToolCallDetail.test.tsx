import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../lib/toolCalls.js";
import { ToolCallDetail } from "./ToolCallDetail.js";

afterEach(() => {
  cleanup();
});

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    toolUseId: "tool-use-1",
    name: "editToolCall",
    inputPreview: "poem.md",
    inputFull: {},
    output: null,
    status: "done",
    createdAt: "2026-05-30T12:00:00.000Z",
    completedAt: "2026-05-30T12:00:01.000Z",
    error: null,
    ...overrides
  };
}

describe("ToolCallDetail", () => {
  it("renders Cursor streamContent as a file preview without repeating the path chrome", () => {
    render(
      <ToolCallDetail
        workspaceCwd="/repo"
        tool={tool({
          inputFull: {
            path: "/repo/poem.md",
            streamContent: "# Hex Context Loop\n\nThe loop begins where context ends.\n"
          }
        })}
      />
    );

    const preview = screen.getByLabelText("Preview of /repo/poem.md");
    expect(within(preview).getByText("Preview")).toBeInTheDocument();
    expect(within(preview).getByText(/The loop begins/)).toBeInTheDocument();
    expect(within(preview).queryByRole("button", { name: "Open /repo/poem.md" })).toBeNull();

    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText("Raw input")).not.toBeInTheDocument();
  });

  it("shows an MCP result's payload instead of its envelope", () => {
    render(
      <ToolCallDetail
        tool={tool({
          name: "mcp__claude_ai_Notion__notion-fetch",
          inputPreview: "",
          inputFull: { id: "28df6da7" },
          output: JSON.stringify({
            metadata: { type: "page" },
            title: "Todo",
            url: "https://app.notion.com/p/28df6da7",
            text: "Prio\n- [ ] mpa"
          })
        })}
      />
    );

    const body = screen.getByText(/- \[ \] mpa/);
    expect(body.textContent).toBe("Prio\n- [ ] mpa");
    expect(screen.getByText(/— Todo/)).toBeInTheDocument();
  });

  it("leaves a JSON file's own bytes alone when a read prints it", () => {
    const contents = '{"name":"argmax","version":"0.4.0"}';
    render(
      <ToolCallDetail
        tool={tool({ name: "Read", inputFull: { file_path: "/repo/package.json" }, output: contents })}
      />
    );

    expect(screen.getByText(contents).textContent).toBe(contents);
  });

  it("does not repeat an openable file row when read output is already shown", () => {
    render(
      <ToolCallDetail
        workspaceCwd="/repo"
        tool={tool({
          name: "Read",
          inputFull: { file_path: "/repo/README.md" },
          output: "# llm-infer\n\nREADME body"
        })}
      />
    );

    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/README body/)).toBeInTheDocument();
    expect(screen.queryByText("README.md")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open /repo/README.md" })).toBeNull();
  });

  it("expands a short bash call straight to Output, with no Command or Input dump", () => {
    // The row already reads "Ran find ./src -type f". Restating that under a
    // Command label, then dumping {command, timeout_ms} as Input, was three
    // copies of the same fact.
    render(
      <ToolCallDetail
        workspaceCwd="/Users/adam/dev/argmax"
        tool={tool({
          name: "command_execution",
          inputPreview: "/bin/zsh -lc \"npm run lint\"",
          inputFull: {
            command: "/bin/zsh -lc \"find /Users/adam/dev/argmax/src -type f\"",
            timeout_ms: 30000
          },
          output: "ok"
        })}
      />
    );

    expect(screen.queryByText("Command")).toBeNull();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText(/"command"/)).toBeNull();
    expect(screen.queryByText(/\/bin\/zsh/)).toBeNull();
  });

  it("hides Claude Bash description and timeout instead of dumping them as Input", () => {
    render(
      <ToolCallDetail
        tool={tool({
          name: "Bash",
          inputPreview: "uv run python analysis/run.py --jobs 5",
          inputFull: {
            command: "uv run python analysis/run.py --jobs 5 --output /tmp/m",
            description: "Confirm E12 reproduction and collect the human artifact hash",
            timeout: 900000
          },
          output: "E12 default artifact still reproduces: True"
        })}
      />
    );

    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText(/"description"/)).toBeNull();
    expect(screen.queryByText("Command")).toBeNull();
    expect(screen.getByText(/E12 default artifact still reproduces/)).toBeInTheDocument();
  });

  it("shows a heredoc as a readable Command block, not escaped JSON", () => {
    const heredoc = [
      "python3 - <<'PY'",
      "print('hello')",
      "print('world')",
      "PY"
    ].join("\n");
    render(
      <ToolCallDetail
        tool={tool({
          name: "Bash",
          inputPreview: heredoc.slice(0, 40),
          inputFull: {
            command: heredoc,
            description: "print two lines",
            timeout: 60000
          },
          output: "hello\nworld"
        })}
      />
    );

    expect(screen.queryByText("Command")).toBeNull();
    const command = screen.getByText(/print\('hello'\)/);
    expect(command.textContent).toBe(heredoc);
    expect(command.textContent).not.toContain("\\n");
    expect(screen.queryByText("Input")).toBeNull();
    const outputLabel = screen.getByText("Output");
    expect(outputLabel.nextElementSibling?.textContent).toBe("hello\nworld");
  });
});
