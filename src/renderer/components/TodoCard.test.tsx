import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TodoCard } from "./TodoCard.js";
import type { TodoItem, TodoList } from "../lib/todoList.js";

function list(items: TodoItem[]): TodoList {
  return {
    items,
    updatedAt: "2026-01-01T00:00:00.000Z",
    doneCount: items.filter((item) => item.status === "done").length,
    active: items.find((item) => item.status === "active") ?? null
  };
}

const working = list([
  { id: "1", text: "Read the normalizers", status: "done" },
  { id: "2", text: "Write the projection", status: "active" },
  { id: "3", text: "Verify with checks", status: "pending" }
]);

describe("TodoCard", () => {
  it("names each row's state in words, not only in colour", () => {
    render(<TodoCard list={working} running />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByRole("img", { name: "Done" })).toBeTruthy();
    expect(within(rows[1]).getByRole("img", { name: "In progress" })).toBeTruthy();
    expect(within(rows[2]).getByRole("img", { name: "Pending" })).toBeTruthy();
  });

  it("counts what is done against the whole list", () => {
    render(<TodoCard list={working} running />);
    expect(screen.getByRole("button", { name: /Plan 1 of 3/ })).toBeTruthy();
  });

  it("is open while the turn runs and folded once it ends", () => {
    const { rerender } = render(<TodoCard list={working} running />);
    expect(screen.getByRole("button", { name: /Plan/ }).getAttribute("aria-expanded")).toBe("true");
    rerender(<TodoCard list={working} running={false} />);
    expect(screen.getByRole("button", { name: /Plan/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("carries the running step in the headline once folded", () => {
    render(<TodoCard list={working} running={false} />);
    expect(screen.getByRole("button", { name: /· Write the projection/ })).toBeTruthy();
  });

  it("says all done when nothing is left", () => {
    const done = list([
      { id: "1", text: "One", status: "done" },
      { id: "2", text: "Two", status: "done" }
    ]);
    render(<TodoCard list={done} running={false} />);
    expect(screen.getByRole("button", { name: /· all done/ })).toBeTruthy();
  });

  it("says not started before any work begins", () => {
    const fresh = list([
      { id: "1", text: "One", status: "pending" },
      { id: "2", text: "Two", status: "pending" }
    ]);
    render(<TodoCard list={fresh} running={false} />);
    expect(screen.getByRole("button", { name: /· not started/ })).toBeTruthy();
  });

  // The turn ending must not reopen a card the reader just closed.
  it("keeps the reader's choice when the turn ends", () => {
    const { rerender } = render(<TodoCard list={working} running />);
    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    expect(screen.getByRole("button", { name: /Plan/ }).getAttribute("aria-expanded")).toBe("false");
    rerender(<TodoCard list={working} running={false} />);
    expect(screen.getByRole("button", { name: /Plan/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a card the reader opened open after the turn ends", () => {
    const { rerender } = render(<TodoCard list={working} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    rerender(<TodoCard list={working} running={false} />);
    expect(screen.getByRole("button", { name: /Plan/ }).getAttribute("aria-expanded")).toBe("true");
  });

  // Grok addresses an item by id before it has ever sent the text.
  it("labels a row the agent has not named yet", () => {
    const partial = list([{ id: "7", text: null, status: "active" }]);
    render(<TodoCard list={partial} running />);
    expect(screen.getByText("Task 7")).toBeTruthy();
  });

  it("draws no row for an item the agent removed", () => {
    const trimmed = list([
      { id: "1", text: "Keep", status: "pending" },
      { id: "2", text: "Gone", status: "removed" }
    ]);
    render(<TodoCard list={trimmed} running />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("Gone")).toBeNull();
  });
});
