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

  it("is a plain row when there is nothing to open", () => {
    // A finish row whose dispatch fell out of the transcript window carries no
    // session id: it still says what happened, it just goes nowhere.
    render(<MultitaskRow notice={notice({ childSessionId: null, state: "complete" })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fix the README typo")).toBeInTheDocument();
  });
});
