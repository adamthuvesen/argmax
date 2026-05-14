import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnBlock, type TurnToolItem } from "./TurnBlock.js";
import type { ToolCall } from "../lib/toolCalls.js";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "t-1",
    toolUseId: "u-1",
    name: "Read",
    inputPreview: "package.json",
    inputFull: { path: "package.json" },
    output: null,
    status: "done",
    createdAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:02.500Z",
    error: null,
    ...overrides
  };
}

describe("TurnBlock", () => {
  afterEach(() => cleanup());

  it("shows 'Working…' while a tool is running and renders assistantNode", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool({ status: "running", completedAt: null }) }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[]}
        toolsNode={<div data-testid="tools">tools</div>}
        assistantNode={<p data-testid="assistant">assistant text</p>}
        providerLabel="Cursor"
        modelLabel="Composer 2"
      />
    );
    expect(screen.getByRole("button", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
    // Tools expanded while running.
    expect(screen.getByTestId("tools")).toBeInTheDocument();
  });

  it("shows 'Worked for Xs' on completion and auto-collapses the tool group", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool() }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        toolsNode={<div data-testid="tools">tools</div>}
        assistantNode={<p data-testid="assistant">reply</p>}
      />
    );
    // Chip reads "Worked for {elapsed}" (formatElapsed renders seconds).
    const chip = screen.getByRole("button", { name: /Worked for/ });
    expect(chip).toBeInTheDocument();
    // Tools collapsed after completion; assistant remains.
    expect(screen.queryByTestId("tools")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
  });

  it("re-expands the tool group when the chip is clicked after completion", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool() }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        toolsNode={<div data-testid="tools">tools</div>}
        assistantNode={<p data-testid="assistant">reply</p>}
      />
    );
    expect(screen.queryByTestId("tools")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    expect(screen.getByTestId("tools")).toBeInTheDocument();
  });

  it("collapses on click when defaultExpanded is true (user toggle wins both directions)", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool() }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        toolsNode={<div data-testid="tools">tools</div>}
        assistantNode={<p data-testid="assistant">reply</p>}
        defaultExpanded
      />
    );
    // Starts expanded because defaultExpanded=true.
    expect(screen.getByTestId("tools")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    // User collapse must stick — earlier bug reset the toggle on the next render.
    expect(screen.queryByTestId("tools")).not.toBeInTheDocument();
  });

  it("omits the chip when there are no tool items", () => {
    render(
      <TurnBlock
        toolItems={[]}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:00.000Z")]}
        toolsNode={null}
        assistantNode={<p data-testid="assistant">just text</p>}
      />
    );
    expect(screen.queryByRole("button", { name: /Worked|Working/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
  });
});
