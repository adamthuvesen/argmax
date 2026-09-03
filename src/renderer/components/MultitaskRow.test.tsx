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
    ...overrides
  };
}

describe("MultitaskRow", () => {
  afterEach(cleanup);

  it("says it is running alongside, and opens the chat it dispatched", () => {
    const onOpen = vi.fn();
    render(<MultitaskRow notice={notice()} onOpen={onOpen} />);

    expect(screen.getByText("Running alongside")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open multitask: Fix the README typo" }));
    expect(onOpen).toHaveBeenCalledWith("child-1");
  });

  it("says how it ended once it has", () => {
    render(<MultitaskRow notice={notice({ state: "complete" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Finished alongside")).toBeInTheDocument();

    cleanup();
    render(<MultitaskRow notice={notice({ state: "cancelled" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("marks an isolated one, which is not sharing this checkout", () => {
    render(<MultitaskRow notice={notice({ worktree: true })} onOpen={vi.fn()} />);
    expect(screen.getByText("Multitask · isolated")).toBeInTheDocument();
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
    expect(screen.queryByText("Running alongside")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop multitask/ })).toBeNull();
  });

  it("is running again when the session is, whatever the last finish row said", () => {
    render(
      <MultitaskRow notice={notice({ state: "complete" })} liveState="running" onOpen={vi.fn()} />
    );
    expect(screen.getByText("Running alongside")).toBeInTheDocument();
  });

  it("is a plain row when there is nothing to open", () => {
    // A finish row whose dispatch fell out of the transcript window carries no
    // session id: it still says what happened, it just goes nowhere.
    render(<MultitaskRow notice={notice({ childSessionId: null, state: "complete" })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fix the README typo")).toBeInTheDocument();
  });
});
