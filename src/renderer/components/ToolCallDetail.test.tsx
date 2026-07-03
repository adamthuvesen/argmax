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

  it("renders bash command input as a quiet command line instead of raw JSON", () => {
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

    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText("find ./src -type f")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText(/"command"/)).toBeNull();
    expect(screen.queryByText(/\/bin\/zsh/)).toBeNull();
  });
});
