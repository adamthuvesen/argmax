import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultitaskNotice } from "../lib/multitask.js";
import { MultitaskCard } from "./MultitaskCard.js";

function notice(overrides: Partial<MultitaskNotice> = {}): MultitaskNotice {
  return {
    childSessionId: "child-1",
    taskLabel: "Fix the README typo",
    prompt: "Fix the README typo",
    worktree: false,
    state: null,
    answer: null,
    ...overrides
  };
}

describe("MultitaskCard", () => {
  afterEach(cleanup);

  it("says it is running and offers to stop or open it", () => {
    const onOpenSession = vi.fn();
    const onTerminateSession = vi.fn();
    render(
      <MultitaskCard
        notice={notice()}
        onOpenSession={onOpenSession}
        onTerminateSession={onTerminateSession}
      />
    );

    expect(screen.getByText("Running alongside")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop multitask: Fix the README typo" }));
    expect(onTerminateSession).toHaveBeenCalledWith("child-1");
    fireEvent.click(screen.getByRole("button", { name: "Open multitask chat: Fix the README typo" }));
    expect(onOpenSession).toHaveBeenCalledWith("child-1");
  });

  it("shows the answer once it has finished, and drops Stop", () => {
    render(
      <MultitaskCard
        notice={notice({ state: "complete", answer: "Fixed it." })}
        onTerminateSession={vi.fn()}
      />
    );

    expect(screen.getByText("Finished alongside")).toBeInTheDocument();
    expect(screen.getByText("Fixed it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).not.toBeInTheDocument();
  });

  it("names a failed run rather than calling it finished", () => {
    render(<MultitaskCard notice={notice({ state: "failed" })} />);
    expect(screen.getByText("Stopped (failed)")).toBeInTheDocument();
  });

  it("marks an isolated multitask, since it is not editing this checkout", () => {
    render(<MultitaskCard notice={notice({ worktree: true })} />);
    expect(screen.getByText("Isolated")).toBeInTheDocument();
  });
});
