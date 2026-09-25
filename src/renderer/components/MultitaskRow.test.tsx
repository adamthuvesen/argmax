import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MultitaskNotice } from "../lib/multitask.js";
import { multitaskDisplayStatus } from "../lib/multitask.js";
import { MultitaskRow } from "./MultitaskRow.js";

function notice(overrides: Partial<MultitaskNotice> = {}): MultitaskNotice {
  return {
    childSessionId: "child-1",
    taskLabel: "Fix the README typo",
    prompt: "Fix the README typo",
    worktree: false,
    state: null,
    answer: null,
    createdAt: "2026-09-02T10:00:02.000Z",
    ...overrides
  };
}

describe("MultitaskRow", () => {
  afterEach(cleanup);

  it("opens its chat and keeps stop available while it runs", () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    render(<MultitaskRow notice={notice()} liveState="running" onOpen={onOpen} onStop={onStop} />);

    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open multitask: Fix the README typo" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop multitask: Fix the README typo" }));
    expect(onOpen).toHaveBeenCalledWith("child-1");
    expect(onStop).toHaveBeenCalledWith("child-1");
  });

  it("counts from its start while it runs, and says the word when it has none", () => {
    render(
      <MultitaskRow
        notice={notice()}
        liveState="running"
        liveStartedAt={new Date(Date.now() - 95_000).toISOString()}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Running for")).toHaveTextContent(/^1m 3[45]s$/);
    expect(screen.queryByText("Running")).toBeNull();

    cleanup();
    render(<MultitaskRow notice={notice()} liveState="running" onOpen={vi.fn()} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("surfaces live attention and keeps the chat reachable", () => {
    render(
      <MultitaskRow
        notice={notice()}
        liveState="running"
        liveAttention="question-asked"
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByRole("img", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open multitask: Fix the README typo" })).toBeInTheDocument();
    expect(multitaskDisplayStatus("waiting", "approval-needed")).toBe("needs-you");
    expect(multitaskDisplayStatus("blocked", "normal")).toBe("needs-you");
  });

  it("says what an approval wants to run, under the title, while it needs you", () => {
    render(
      <MultitaskRow
        notice={notice()}
        liveState="blocked"
        liveAttention="approval-needed"
        liveApprovalCommand="rm -rf dist && npm run build"
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("Wants to run")).toBeInTheDocument();
    expect(screen.getByText("rm -rf dist && npm run build")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Needs you" })).toBeInTheDocument();
  });

  it("keeps the approval to itself once the chat is running again", () => {
    // A stale command beside a live state would read as this turn's ask.
    render(
      <MultitaskRow
        notice={notice()}
        liveState="running"
        liveAttention="normal"
        liveApprovalCommand="rm -rf dist"
        onOpen={vi.fn()}
      />
    );

    expect(screen.queryByText("Wants to run")).toBeNull();
    expect(screen.queryByText("rm -rf dist")).toBeNull();
  });

  it("keeps a completed question in attention, with nothing left to stop", () => {
    render(
      <MultitaskRow
        notice={notice({ state: "complete", answer: "Should this go under fixes or improvements?" })}
        liveAttention="question-asked"
        onOpen={vi.fn()}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByRole("img", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).toBeNull();
  });

  it("says a task finished in one line, and offers dismissal only when handed one", () => {
    // The answer is not on the row: the dock tab holds the whole reply, and
    // the agent gets it on the next prompt. The row is a pointer, one line.
    render(
      <MultitaskRow
        notice={notice({ state: "complete", answer: "Corrected the 0.4 heading to 2026." })}
        onOpen={vi.fn()}
        onStop={vi.fn()}
      />
    );

    expect(screen.getByRole("img", { name: "Finished" })).toBeInTheDocument();
    expect(screen.queryByText("Corrected the 0.4 heading to 2026.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dismiss multitask/ })).toBeNull();

    cleanup();
    const onDismiss = vi.fn();
    render(<MultitaskRow notice={notice({ state: "complete" })} onOpen={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss multitask: Fix the README typo" }));
    expect(onDismiss).toHaveBeenCalledWith("child-1");
  });

  it("uses the live session state and title over stale launch and finish events", () => {
    render(
      <MultitaskRow
        notice={notice({ state: "complete", answer: "Old result" })}
        liveState="running"
        liveLabel="Fix Install Section Typo"
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open multitask: Fix Install Section Typo" })).toBeInTheDocument();
    expect(screen.queryByText("Old result")).toBeNull();

    cleanup();
    render(<MultitaskRow notice={notice()} liveState="failed" onOpen={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

  it("names an isolated task and leaves an orphaned finish readable", () => {
    render(<MultitaskRow notice={notice({ worktree: true })} onOpen={vi.fn()} />);
    expect(screen.getByText("isolated")).toBeInTheDocument();

    cleanup();
    render(<MultitaskRow notice={notice({ childSessionId: null, state: "complete" })} />);
    expect(screen.getByText("Fix the README typo")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
