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
  it("keeps the animated nest while running and names the state in words too", () => {
    const { container } = render(<AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} />);
    expect(
      screen.getByRole("button", { name: startedAgentName("Map the renderer") })
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(container.querySelector(".working-nest[data-active='true']")).not.toBeNull();
    expect(container.querySelector(".agent-launch-bullet")).toBeNull();
  });

  it("leads with the agent's description and follows it with the codename", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.getByText("Map the renderer")).toBeInTheDocument();
    // The codename is drawn from the moon list, so assert the slot is filled
    // rather than pinning whichever name this toolUseId hashes to.
    expect(document.querySelector(".agent-launch-identity")?.textContent).toBeTruthy();
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

  it("says Completed in words rather than drawing a check", () => {
    const { container } = render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(container.querySelector(".working-nest")).toBeNull();
    expect(container.querySelector('.agent-launch-bullet[data-launch-mark="done"]')).not.toBeNull();
    expect(container.querySelector(".lucide-circle-check-big")).toBeNull();
  });

  it("marks a failed launch with the bullet and the word Failed", () => {
    const { container } = render(<AgentLaunchList tools={[tool({ status: "error" })]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(container.querySelector(".working-nest")).toBeNull();
    expect(container.querySelector('.agent-launch-bullet[data-launch-mark="error"]')).not.toBeNull();
  });
});
