import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnBlock, type TurnBodyChild, type TurnToolItem } from "./TurnBlock.js";
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

function body(...children: TurnBodyChild[]): TurnBodyChild[] {
  return children;
}

const assistantChild = (id: string, label = "assistant text"): TurnBodyChild => ({
  kind: "assistant",
  id,
  node: <p data-testid={id}>{label}</p>
});

const toolChild = (id: string, label = "tools"): TurnBodyChild => ({
  kind: "tool",
  id,
  node: <div data-testid={id}>{label}</div>
});

describe("TurnBlock", () => {
  afterEach(() => cleanup());

  it("shows 'Working…' while a tool is running and renders assistant + tool nodes", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool({ status: "running", completedAt: null }) }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[]}
        body={body(assistantChild("assistant"), toolChild("tools"))}
        providerLabel="Cursor"
        modelLabel="Composer 2"
      />
    );
    expect(screen.getByRole("button", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
    // Tools expanded while running.
    expect(screen.getByTestId("tools")).toBeInTheDocument();
  });

  it("shows 'Worked for Xs' on completion and auto-collapses tool children", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool() }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        body={body(assistantChild("assistant", "reply"), toolChild("tools"))}
      />
    );
    const chip = screen.getByRole("button", { name: /Worked for/ });
    expect(chip).toBeInTheDocument();
    // Tools collapsed after completion; assistant remains.
    expect(screen.queryByTestId("tools")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
  });

  it("re-expands tool children when the chip is clicked after completion", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool() }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        body={body(assistantChild("assistant", "reply"), toolChild("tools"))}
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
        body={body(assistantChild("assistant", "reply"), toolChild("tools"))}
        defaultExpanded
      />
    );
    expect(screen.getByTestId("tools")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    // User collapse must stick — earlier bug reset the toggle on the next render.
    expect(screen.queryByTestId("tools")).not.toBeInTheDocument();
  });

  it("respects defaultExpanded while the turn is still running", () => {
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool({ status: "running", completedAt: null }) }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[]}
        body={body(assistantChild("assistant", "streaming..."), toolChild("tools"))}
        defaultExpanded
      />
    );
    expect(screen.getByTestId("tools")).toBeInTheDocument();
  });

  it("omits the chip when there are no tool items", () => {
    render(
      <TurnBlock
        toolItems={[]}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:00.000Z")]}
        body={body(assistantChild("assistant", "just text"))}
      />
    );
    expect(screen.queryByRole("button", { name: /Worked|Working/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant")).toBeInTheDocument();
  });

  it("renders body children in the order given so tools stay where they happened in chat", () => {
    // Caller is responsible for sorting; TurnBlock must preserve that order
    // so a tool that ran before the final assistant message is shown above
    // the message — not yanked to the bottom of the turn.
    const items: TurnToolItem[] = [{ kind: "tool", tool: tool({ id: "search" }) }];
    render(
      <TurnBlock
        toolItems={items}
        assistantTimestamps={[Date.parse("2026-05-12T15:00:03.000Z")]}
        body={body(
          toolChild("tool-before", "search call"),
          assistantChild("assistant-after", "final answer")
        )}
        defaultExpanded
      />
    );
    const tool0 = screen.getByTestId("tool-before");
    const after = screen.getByTestId("assistant-after");
    // tool-before must appear before assistant-after in document order.
    expect(tool0.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
