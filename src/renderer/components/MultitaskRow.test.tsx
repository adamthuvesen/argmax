import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultitaskNotice } from "../lib/multitask.js";
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

  it("says it is running, and opens the chat it dispatched", () => {
    const onOpen = vi.fn();
    render(<MultitaskRow notice={notice()} onOpen={onOpen} />);

    expect(screen.getByText("Running")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open multitask: Fix the README typo" }));
    expect(onOpen).toHaveBeenCalledWith("child-1");
  });

  it("says how it ended once it has", () => {
    render(<MultitaskRow notice={notice({ state: "complete" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();

    cleanup();
    render(<MultitaskRow notice={notice({ state: "cancelled" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("says what it found, in one line, once it has finished", () => {
    render(
      <MultitaskRow
        notice={notice({ state: "complete", answer: "Corrected the 0.4 heading to 2026." })}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText(/Corrected the 0.4 heading to 2026\./)).toBeInTheDocument();
  });

  it("drops a stale answer the moment it is running again", () => {
    // Answered again from its dock tab: the old result beside a live status
    // would read as this turn's.
    render(
      <MultitaskRow
        notice={notice({ state: "complete", answer: "Corrected the 0.4 heading to 2026." })}
        liveState="running"
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText(/Corrected the 0.4 heading/)).toBeNull();
  });

  it("says a blocked multitask is waiting on the person, not running", () => {
    render(<MultitaskRow notice={notice({ state: "blocked" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
  });

  it("marks an isolated one, which is not sharing this checkout", () => {
    render(<MultitaskRow notice={notice({ worktree: true })} onOpen={vi.fn()} />);
    expect(screen.getByText("Multitask · isolated")).toBeInTheDocument();
  });

  it("can be dismissed once it has settled, but not while it runs", () => {
    const onDismiss = vi.fn();
    render(<MultitaskRow notice={notice()} onOpen={vi.fn()} onDismiss={onDismiss} />);
    expect(
      screen.queryByRole("button", { name: "Dismiss multitask: Fix the README typo" })
    ).toBeNull();

    cleanup();
    render(
      <MultitaskRow notice={notice({ state: "complete" })} onOpen={vi.fn()} onDismiss={onDismiss} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss multitask: Fix the README typo" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("stops the multitask from the row", () => {
    const onStop = vi.fn();
    render(<MultitaskRow notice={notice()} onOpen={vi.fn()} onStop={onStop} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop multitask: Fix the README typo" }));
    expect(onStop).toHaveBeenCalledWith("child-1");
  });

  it("offers no stop once it has stopped", () => {
    render(<MultitaskRow notice={notice({ state: "complete" })} onOpen={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).toBeNull();
  });

  it("believes the session over a timeline that never saw it end", () => {
    // The app went down mid-turn, so no finish row was ever written; the
    // session row is what knows the process did not survive.
    render(<MultitaskRow notice={notice()} liveState="failed" onOpen={vi.fn()} onStop={vi.fn()} />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).toBeNull();
  });

  it("is running again when the session is, whatever the last finish row said", () => {
    render(
      <MultitaskRow notice={notice({ state: "complete" })} liveState="running" onOpen={vi.fn()} />
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("is a plain row when there is nothing to open", () => {
    // A finish row whose dispatch fell out of the transcript window carries no
    // session id: it still says what happened, it just goes nowhere.
    render(<MultitaskRow notice={notice({ childSessionId: null, state: "complete" })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fix the README typo")).toBeInTheDocument();
  });
});
