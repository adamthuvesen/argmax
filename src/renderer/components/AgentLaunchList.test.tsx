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
  it("marks a running launch on its own words, and names the state in words too", () => {
    // The turn is blocked on this agent, so the row is the live line the reader
    // is watching — marked the way a running tool row is marked, with the
    // reading wave through its words rather than with a dot beside them.
    const { container } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} onOpenAgent={vi.fn()} />
    );
    expect(
      screen.getByRole("button", { name: startedAgentName("Map the renderer") })
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(container.querySelector(".agent-launch-headline[data-reading-wave='true']")).not.toBeNull();
    expect(container.querySelector(".agent-launch-title.reading-wave-text")).not.toBeNull();
    expect(container.querySelector(".agent-launch-identity.reading-wave-text")).not.toBeNull();
    expect(container.querySelector(".working-nest")).toBeNull();
    // The emblem is this agent's identity, not a prize for finishing, so it is
    // in the slot from the launch.
    expect(
      container.querySelector(".agent-launch-emblem[data-launch-mark='running'] .agent-emblem[data-shape]")
    ).not.toBeNull();
  });

  it("keeps the nest for a backgrounded launch, whose progress nobody can watch", () => {
    // No completion ever arrives for one of these, so the row is running by
    // inference. A band reading its words for the rest of the session would
    // claim progress the app cannot see; a status mark says only that it is
    // alive somewhere else.
    const { container } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null, backgroundLaunch: true })]} />
    );
    expect(container.querySelector(".working-nest[data-active='true']")).not.toBeNull();
    expect(container.querySelector(".agent-launch-headline[data-reading-wave='true']")).toBeNull();
    // The row carries the agent's hue while it runs, so the nest lands in the
    // colour its emblem is about to take.
    expect(container.querySelector(".agent-launch-row.agent-emblem-tint[data-hue]")).not.toBeNull();
    expect(container.querySelector(".agent-launch-emblem")).toBeNull();
  });

  it("holds a backgrounded launch's nest through its landing before the emblem takes over", () => {
    // The nest's landing is the only thing that marks one of these arriving, and
    // it lives on the nest — so swapping straight to the emblem the frame work
    // stops means it never plays at all. That is how it was unreachable in the
    // shipped app: every caller unmounted the mark instead of settling it.
    vi.useFakeTimers();
    try {
      const running = tool({ status: "running", completedAt: null, backgroundLaunch: true });
      const { container, rerender } = render(<AgentLaunchList tools={[running]} />);
      rerender(<AgentLaunchList tools={[tool({ status: "done", backgroundLaunch: true })]} />);
      expect(container.querySelector(".working-nest[data-settling='true']")).not.toBeNull();
      expect(container.querySelector(".agent-launch-emblem")).toBeNull();
      act(() => void vi.advanceTimersByTime(WORKING_NEST_SETTLE_MS));
      expect(container.querySelector(".working-nest")).toBeNull();
      expect(container.querySelector(".agent-launch-emblem .agent-emblem[data-shape]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a backgrounded agent that errored straight to its emblem, with no landing", () => {
    const { container, rerender } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null, backgroundLaunch: true })]} />
    );
    rerender(<AgentLaunchList tools={[tool({ status: "error", backgroundLaunch: true })]} />);
    expect(container.querySelector(".working-nest")).toBeNull();
    expect(container.querySelector(".agent-launch-emblem[data-launch-mark='error']")).not.toBeNull();
  });

  it("fades up only the word that changed when the agent lands", () => {
    // The status word is the one part that re-words, and the settle is the
    // moment it is worth reading — so it commits at once and moves on its own.
    // Dipping the whole row would re-animate a task title that never changed.
    const { container, rerender } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} />
    );
    rerender(<AgentLaunchList tools={[tool({ status: "done" })]} />);
    expect(container.querySelector(".agent-launch-status[data-arriving='true']")?.textContent)
      .toBe("Completed");
    expect(container.querySelector(".agent-launch-title[data-arriving='true']")).toBeNull();
    // And the band is gone with the work it was marking.
    expect(container.querySelector(".agent-launch-headline[data-reading-wave='true']")).toBeNull();
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
        onOpenAgent={vi.fn()}
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
    const emblem = container.querySelector('.agent-launch-emblem[data-launch-mark="done"] .agent-emblem');
    expect(emblem?.getAttribute("data-status")).toBe("done");
    expect(container.querySelector(".lucide-circle-check-big")).toBeNull();
  });

  it("omits the details toggle when expanding would show nothing", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.queryByRole("button", { name: toggleAgentDetailsName("Map the renderer") })).toBeNull();
  });

  it("keeps the details toggle when the launch produced output", () => {
    render(<AgentLaunchList tools={[tool({ output: "done" })]} onOpenAgent={vi.fn()} />);
    expect(screen.getByRole("button", { name: toggleAgentDetailsName("Map the renderer") })).toBeInTheDocument();
  });

  it("stays a record, not a control, where there is no dock to open it in", () => {
    // The phone hands the row no handler: it names the delegated work and the
    // state it reached, and nothing on it can be pressed — there is no Agents
    // view on that surface for a press to land in.
    render(<AgentLaunchList tools={[tool({ output: "done" })]} />);
    expect(screen.getByText("Map the renderer")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("marks a failed launch with the bullet and the word Failed", () => {
    const { container } = render(<AgentLaunchList tools={[tool({ status: "error" })]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(container.querySelector(".working-nest")).toBeNull();
    // Greyed and dotted, never recoloured: the hue says who, not how it went.
    const emblem = container.querySelector('.agent-launch-emblem[data-launch-mark="error"] .agent-emblem');
    expect(emblem?.getAttribute("data-status")).toBe("error");
    expect(emblem?.querySelector(".agent-emblem-fault")).not.toBeNull();
  });
});
