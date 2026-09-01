import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../lib/toolCalls.js";
import { ToolCallRow } from "./ToolCallRow.js";

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
