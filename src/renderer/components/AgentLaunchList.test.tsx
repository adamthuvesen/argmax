import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { startedAgentName } from "../../test/agentRowName.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentLaunchList } from "./AgentLaunchList.js";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "t1",
    toolUseId: "t1",
    name: "Task",
    inputPreview: "Map the renderer",
    inputFull: { description: "Map the renderer" },
    output: null,
    status: "done",
    createdAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:01.000Z",
    error: null,
    ...overrides
  };
}

describe("AgentLaunchList", () => {
  it("names a running launch so the animated nest mark is never the only signal", () => {
    const { container } = render(<AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} />);
    expect(
      screen.getByRole("button", { name: startedAgentName("Map the renderer") })
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText(/^Launched /)).toBeInTheDocument();
    expect(container.querySelector(".working-nest[data-active='true']")).not.toBeNull();
  });

  it("shows the codename instead of the launch prompt", () => {
    const prompt =
      "Inspect the repository at /Users/adamthuvesen/dev/menti/revops-backoffice. Summarize what it does.";
    render(
      <AgentLaunchList
        tools={[tool({
          inputPreview: prompt.slice(0, 72),
          inputFull: { prompt }
        })]}
      />
    );
    expect(
      screen.getByRole("button", { name: startedAgentName(prompt.slice(0, 72)) })
    ).toBeInTheDocument();
    expect(screen.getByText(/^Launched /)).toBeInTheDocument();
    expect(screen.queryByText(/revops-backoffice/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Inspect the repository/)).not.toBeInTheDocument();
  });

  it("leaves a completed launch without a status hint", () => {
    const { container } = render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(container.querySelector(".working-nest[data-active='true']")).toBeNull();
  });
});
