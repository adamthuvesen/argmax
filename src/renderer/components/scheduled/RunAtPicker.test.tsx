import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunAtPicker } from "./RunAtPicker.js";

afterEach(cleanup);

describe("RunAtPicker", () => {
  it("writes the datetime-local value the schedule code reads", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 28, 12, 0));
    const onChange = vi.fn();
    render(<RunAtPicker value="2026-09-30T08:30" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Wed, Sep 30/ }));
    // A past day cannot be chosen; the next month can.
    expect(screen.getByRole("button", { name: /September 27, 2026/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(screen.getByRole("button", { name: /October 15, 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-15T08:30");

    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "17:45" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-30T17:45");
    vi.useRealTimers();
  });
});
