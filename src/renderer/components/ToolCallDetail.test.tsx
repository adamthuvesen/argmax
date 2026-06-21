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
  it("renders Cursor streamContent as a file preview before raw input", () => {
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
    expect(within(preview).getByText("poem.md")).toBeInTheDocument();
    expect(within(preview).getByText(/The loop begins/)).toBeInTheDocument();
    expect(within(preview).getByRole("button", { name: "Open /repo/poem.md" })).toBeInTheDocument();

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.queryByText("Raw input")).not.toBeInTheDocument();
  });
});
