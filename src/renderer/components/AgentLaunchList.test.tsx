import { act, render, screen, within } from "@testing-library/react";
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
    ...overrides,
  };
}

describe("AgentLaunchList", () => {
  it("marks a running launch on its own words, and names the state in words too", () => {
    // The turn is blocked on this agent, so the row is the live line the reader
    // is watching — marked the way a running tool row is marked, with the
    // reading wave through its words rather than with a dot beside them.
    render(
      <AgentLaunchList
        tools={[tool({ status: "running", completedAt: null })]}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: startedAgentName("Map the renderer") }),
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByTestId("agent-launch-headline")).toHaveAttribute(
      "data-reading-wave",
      "true",
    );
    expect(screen.getByTestId("agent-launch-title")).toHaveClass("reading-wave-text");
    expect(screen.getByTestId("agent-launch-identity")).toHaveClass("reading-wave-text");
    expect(screen.queryByTestId("working-nest")).toBeNull();
    // The emblem is this agent's identity, not a prize for finishing, so it is
    // in the slot from the launch.
    const emblemSlot = screen.getByTestId("agent-launch-emblem");
    expect(emblemSlot).toHaveAttribute("data-launch-mark", "running");
    expect(within(emblemSlot).getByTestId("agent-emblem")).toHaveAttribute("data-shape");
  });

  it("keeps the nest for a backgrounded launch, whose progress nobody can watch", () => {
    // No completion ever arrives for one of these, so the row is running by
    // inference. A band reading its words for the rest of the session would
    // claim progress the app cannot see; a status mark says only that it is
    // alive somewhere else.
    render(
      <AgentLaunchList
        tools={[tool({ status: "running", completedAt: null, backgroundLaunch: true })]}
      />,
    );
    expect(screen.getByTestId("working-nest")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("agent-launch-headline")).not.toHaveAttribute(
      "data-reading-wave",
      "true",
    );
    // The row carries the agent's hue while it runs, so the nest lands in the
    // colour its emblem is about to take.
    const row = screen.getByTestId("agent-launch-row");
    expect(row).toHaveClass("agent-emblem-tint");
    expect(row).toHaveAttribute("data-hue");
    expect(screen.queryByTestId("agent-launch-emblem")).toBeNull();
  });

  it("holds a backgrounded launch's nest through its landing before the emblem takes over", () => {
    // The nest's landing is the only thing that marks one of these arriving, and
    // it lives on the nest — so swapping straight to the emblem the frame work
    // stops means it never plays at all. That is how it was unreachable in the
    // shipped app: every caller unmounted the mark instead of settling it.
    vi.useFakeTimers();
    try {
      const running = tool({ status: "running", completedAt: null, backgroundLaunch: true });
      const { rerender } = render(<AgentLaunchList tools={[running]} />);
      rerender(<AgentLaunchList tools={[tool({ status: "done", backgroundLaunch: true })]} />);
      expect(screen.getByTestId("working-nest")).toHaveAttribute("data-settling", "true");
      expect(screen.queryByTestId("agent-launch-emblem")).toBeNull();
      act(() => void vi.advanceTimersByTime(WORKING_NEST_SETTLE_MS));
      expect(screen.queryByTestId("working-nest")).toBeNull();
      expect(
        within(screen.getByTestId("agent-launch-emblem")).getByTestId("agent-emblem"),
      ).toHaveAttribute("data-shape");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a backgrounded agent that errored straight to its emblem, with no landing", () => {
    const { rerender } = render(
      <AgentLaunchList
        tools={[tool({ status: "running", completedAt: null, backgroundLaunch: true })]}
      />,
    );
    rerender(<AgentLaunchList tools={[tool({ status: "error", backgroundLaunch: true })]} />);
    expect(screen.queryByTestId("working-nest")).toBeNull();
    expect(screen.getByTestId("agent-launch-emblem")).toHaveAttribute("data-launch-mark", "error");
  });

  it("fades up only the word that changed when the agent lands", () => {
    // The status word is the one part that re-words, and the settle is the
    // moment it is worth reading — so it commits at once and moves on its own.
    // Dipping the whole row would re-animate a task title that never changed.
    const { rerender } = render(
      <AgentLaunchList tools={[tool({ status: "running", completedAt: null })]} />,
    );
    rerender(<AgentLaunchList tools={[tool({ status: "done" })]} />);
    const status = screen.getByTestId("agent-launch-status");
    expect(status).toHaveAttribute("data-arriving", "true");
    expect(status.textContent).toBe("Completed");
    expect(screen.getByTestId("agent-launch-title")).not.toHaveAttribute("data-arriving", "true");
    // And the band is gone with the work it was marking.
    expect(screen.getByTestId("agent-launch-headline")).not.toHaveAttribute(
      "data-reading-wave",
      "true",
    );
  });

  it("shows the codename instead of the launch prompt", () => {
    const prompt =
      "Inspect the repository at /Users/adamthuvesen/dev/menti/revops-backoffice. Summarize what it does.";
    render(
      <AgentLaunchList
        tools={[
          tool({
            inputPreview: prompt.slice(0, 72),
            inputFull: { prompt },
          }),
        ]}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: startedAgentName(prompt.slice(0, 72)) }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Launched /)).toBeInTheDocument();
    expect(screen.queryByText(/revops-backoffice/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Inspect the repository/)).not.toBeInTheDocument();
  });

  it("says Completed in words rather than drawing a check", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByTestId("working-nest")).toBeNull();
    const emblemSlot = screen.getByTestId("agent-launch-emblem");
    expect(emblemSlot).toHaveAttribute("data-launch-mark", "done");
    expect(within(emblemSlot).getByTestId("agent-emblem")).toHaveAttribute("data-status", "done");
    expect(
      screen.queryAllByText(
        (_, element) => element?.classList.contains("lucide-circle-check-big") ?? false,
        { ignore: false },
      ),
    ).toHaveLength(0);
  });

  it("omits the details toggle when expanding would show nothing", () => {
    render(<AgentLaunchList tools={[tool()]} />);
    expect(
      screen.queryByRole("button", { name: toggleAgentDetailsName("Map the renderer") }),
    ).toBeNull();
  });

  it("keeps the details toggle when the launch produced output", () => {
    render(<AgentLaunchList tools={[tool({ output: "done" })]} onOpenAgent={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: toggleAgentDetailsName("Map the renderer") }),
    ).toBeInTheDocument();
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
    render(<AgentLaunchList tools={[tool({ status: "error" })]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByTestId("working-nest")).toBeNull();
    // Greyed and dotted, never recoloured: the hue says who, not how it went.
    const emblemSlot = screen.getByTestId("agent-launch-emblem");
    expect(emblemSlot).toHaveAttribute("data-launch-mark", "error");
    const emblem = within(emblemSlot).getByTestId("agent-emblem");
    expect(emblem).toHaveAttribute("data-status", "error");
    expect(within(emblem).getByTestId("agent-emblem-fault")).toBeInTheDocument();
  });
});
