import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { startedAgentName, toggleAgentDetailsName } from "../../test/agentRowName.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentLaunchList } from "./AgentLaunchList.js";
import { WORKING_NEST_SETTLE_MS } from "./WorkingNest.js";

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

  it("holds the nest through its landing before the finished bullet takes over", () => {
    // The nest's landing is the only thing that marks an agent arriving, and it
    // lives on the nest — so swapping straight to the bullet the frame work
    // stops means it never plays at all. That is how it was unreachable in the
    // shipped app: every caller unmounted the mark instead of settling it.
    vi.useFakeTimers();
    try {
      const running = tool({ status: "running", completedAt: null });
      const { container, rerender } = render(<AgentLaunchList tools={[running]} />);
      rerender(<AgentLaunchList tools={[tool({ status: "done" })]} />);
      expect(container.querySelector(".working-nest[data-settling='true']")).not.toBeNull();
      expect(container.querySelector(".agent-launch-bullet")).toBeNull();
      act(() => void vi.advanceTimersByTime(WORKING_NEST_SETTLE_MS));
      expect(container.querySelector(".working-nest")).toBeNull();
      expect(container.querySelector(".agent-launch-bullet")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends an agent that errored straight to its bullet, with no landing", () => {
    const { container, rerender } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} />
    );
    rerender(<AgentLaunchList tools={[tool({ status: "error" })]} />);
    expect(container.querySelector(".working-nest")).toBeNull();
    expect(container.querySelector(".agent-launch-bullet[data-launch-mark='error']")).not.toBeNull();
  });

  it("leads with the agent's description and follows it with the codename", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.getByText("Map the renderer")).toBeInTheDocument();
    // The codename is drawn from the scientist list, so assert the slot is filled
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

  it("omits the details toggle when expanding would show nothing", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.queryByRole("button", { name: toggleAgentDetailsName("Map the renderer") })).toBeNull();
  });

  it("keeps the details toggle when the launch produced output", () => {
    render(<AgentLaunchList tools={[tool({ output: "done" })]} />);
    expect(screen.getByRole("button", { name: toggleAgentDetailsName("Map the renderer") })).toBeInTheDocument();
  });

  it("marks a failed launch with the bullet and the word Failed", () => {
    const { container } = render(<AgentLaunchList tools={[tool({ status: "error" })]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(container.querySelector(".working-nest")).toBeNull();
    expect(container.querySelector('.agent-launch-bullet[data-launch-mark="error"]')).not.toBeNull();
  });
});
