import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildToolCallGroup, type ToolCall } from "../lib/toolCalls.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tool(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    toolUseId: id,
    name: "Read",
    inputPreview: `${id}.ts`,
    inputFull: { file_path: `/repo/${id}.ts` },
    output: `Contents of ${id}`,
    status: "done",
    createdAt: "2026-09-05T12:00:00.000Z",
    completedAt: "2026-09-05T12:00:01.000Z",
    error: null,
    ...overrides
  };
}

describe("ToolCallGroupBubble", () => {
  it("opens compact rows before their output and keeps the group open as work finishes", () => {
    const first = tool("first");
    const second = tool("second", { status: "running", completedAt: null });
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} />);

    const header = screen.getByRole("button", { name: /^Read files/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Read first.ts" })).toBeNull();
    fireEvent.click(header);
    expect(screen.getByRole("button", { name: "Read first.ts" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Contents of first")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Read first.ts" }));
    expect(screen.getByText("Contents of first")).toBeInTheDocument();

    rerender(<ToolCallGroupBubble group={buildToolCallGroup([first, { ...second, status: "done" }])} />);
    expect(screen.getByRole("button", { name: "Read files" })).toBe(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Contents of first")).toBeInTheDocument();
  });

  it("preserves a reader's expansion when one call grows into a group", () => {
    const first = tool("first");
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first])} />);
    expect(screen.queryByRole("button", { name: "Read a file" })).toBeNull();
    const singletonRow = screen.getByRole("button", { name: "Read first.ts" });
    const mountedGroup = singletonRow.parentElement?.parentElement;
    fireEvent.click(singletonRow);
    expect(screen.getByText("Contents of first")).toBeInTheDocument();

    rerender(<ToolCallGroupBubble group={buildToolCallGroup([first, tool("second")])} />);
    const groupHeader = screen.getByRole("button", { name: "Read files" });
    expect(groupHeader.parentElement).toBe(mountedGroup);
    expect(groupHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Read first.ts" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Contents of first")).toBeInTheDocument();
  });

  it("keeps a compact single command quiet until each disclosure is opened", () => {
    const command = tool("command", {
      name: "Bash",
      inputPreview: "npm test -- --runInBand",
      inputFull: { command: "npm test -- --runInBand" },
      output: "Tests passed"
    });
    const { rerender } = render(
      <ToolCallGroupBubble compact group={buildToolCallGroup([command])} />
    );

    const header = screen.getByRole("button", { name: "Ran a command" });
    expect(screen.queryByRole("button", { name: "Ran npm test -- --runInBand" })).toBeNull();
    expect(screen.queryByText("Tests passed")).toBeNull();

    fireEvent.click(header);
    const commandRow = screen.getByRole("button", { name: "Ran npm test -- --runInBand" });
    expect(commandRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Tests passed")).toBeNull();
    fireEvent.click(commandRow);
    expect(screen.getByText("Tests passed")).toBeInTheDocument();

    rerender(
      <ToolCallGroupBubble compact group={buildToolCallGroup([command, tool("second")])} />
    );
    expect(screen.getByRole("button", { name: "Read a file, ran a command" })).toBe(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Tests passed")).toBeInTheDocument();
  });

  it("does not expose a live action caption in a collapsed compact group", () => {
    const running = tool("second", { status: "running", completedAt: null });
    render(
      <ToolCallGroupBubble compact group={buildToolCallGroup([tool("first"), running])} />
    );

    expect(screen.getByRole("button", { name: "Read files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read second\.ts/ })).toBeNull();
    expect(screen.queryByText("Read second.ts")).toBeNull();
  });

  it("keeps a compact singleton failure quiet while collapsed", () => {
    const failed = tool("failed", {
      name: "Bash",
      inputPreview: "npm test",
      inputFull: { command: "npm test" },
      status: "error",
      error: "Tests failed"
    });
    render(<ToolCallGroupBubble compact group={buildToolCallGroup([failed])} />);

    const header = screen.getByRole("button", { name: "Ran a command" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Tests failed")).not.toBeInTheDocument();
    expect(screen.queryByText("npm test")).toBeNull();
  });

  it("holds the edit total back until the group stops working", () => {
    const edit = tool("edit", {
      name: "Edit",
      inputPreview: "first.ts",
      inputFull: {
        file_path: "/repo/first.ts",
        old_string: "old one\nold two",
        new_string: "new one\nnew two"
      }
    });
    const running = tool("running", { status: "running", completedAt: null });
    const { rerender } = render(
      <ToolCallGroupBubble group={buildToolCallGroup([edit, running])} />
    );

    // Both would otherwise claim the trailing slot and split it, parking a live
    // animation mid-row beside a total that is still growing.
    expect(screen.getByLabelText("running")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Group edits:/ })).toBeNull();

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([edit, { ...running, status: "done" }])}
      />
    );

    expect(screen.queryByLabelText("running")).toBeNull();
    expect(
      screen.getByRole("img", { name: "Group edits: 2 lines added, 2 lines removed" })
    ).toBeInTheDocument();
  });

  it("keeps cumulative edit totals on the group header as interleaved tools arrive", () => {
    const firstEdit = tool("first-edit", {
      name: "Edit",
      inputPreview: "first.ts",
      inputFull: {
        file_path: "/repo/first.ts",
        old_string: "old one\nold two",
        new_string: "new one\nnew two"
      }
    });
    const secondEdit = tool("second-edit", {
      name: "Write",
      inputPreview: "second.ts",
      inputFull: {
        file_path: "/repo/second.ts",
        content: "one\ntwo\nthree"
      },
      completionObserved: false
    });
    const firstRead = tool("first-read");
    const secondRead = tool("second-read");
    const { rerender } = render(
      <ToolCallGroupBubble group={buildToolCallGroup([firstRead, firstEdit, secondRead])} />
    );

    const header = screen.getByRole("button", { name: "Edited a file, read files" });
    const initialStat = screen.getByRole("img", {
      name: "Group edits: 2 lines added, 2 lines removed"
    });
    expect(header).toContainElement(initialStat);
    expect(initialStat).toHaveTextContent("+2");
    expect(initialStat).toHaveTextContent("−2");
    expect(initialStat).not.toHaveTextContent("files");

    fireEvent.click(header);
    expect(screen.getAllByRole("img", { name: /Group edits:/ })).toHaveLength(1);
    expect(header).toContainElement(initialStat);

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([firstRead, firstEdit, secondRead, secondEdit])}
      />
    );
    const updatedHeader = screen.getByRole("button", { name: "Edited files, read files" });
    expect(screen.getByRole("img", {
      name: "Group edits: 2 lines added, 2 lines removed"
    })).toBeInTheDocument();

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([
          firstRead,
          firstEdit,
          secondRead,
          { ...secondEdit, completionObserved: true }
        ])}
      />
    );
    const updatedStat = screen.getByRole("img", {
      name: "Group edits: 5 lines added, 2 lines removed"
    });
    expect(updatedHeader).toBe(header);
    expect(updatedHeader).toContainElement(updatedStat);
    expect(screen.getAllByRole("img", { name: /Group edits:/ })).toHaveLength(1);
  });

  it("keeps a fast action caption for a 600ms minimum dwell without faking its status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    const first = tool("first");
    const second = tool("second", { status: "running", completedAt: null });
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} />);

    const header = screen.getByRole("button", { name: "Read files: Read second.ts" });
    expect(header.parentElement).toHaveAttribute("data-status", "running");
    await act(() => vi.advanceTimersByTime(200));

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([{ ...first }, { ...second, status: "done", completedAt: "2026-09-05T12:00:00.200Z" }])}
      />
    );
    expect(screen.getByRole("button", { name: "Read files: Read second.ts" })).toBe(header);
    expect(header.parentElement).toHaveAttribute("data-status", "done");
    expect(screen.queryByLabelText("running")).toBeNull();

    await act(() => vi.advanceTimersByTime(399));
    expect(screen.getByRole("button", { name: "Read files: Read second.ts" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: "Read files" })).toBe(header);
  });

  it("replaces the settling caption immediately when the next action starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    const first = tool("first");
    const second = tool("second", { status: "running", completedAt: null });
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} />);
    expect(screen.getByRole("button", { name: "Read files: Read second.ts" })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(100));
    const third = tool("third", {
      name: "Bash",
      inputPreview: "npm test",
      inputFull: { command: "npm test" },
      status: "running",
      completedAt: null
    });
    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([{ ...first }, { ...second, status: "done" }, third])}
      />
    );

    expect(screen.getByRole("button", {
      name: "Read files, ran a command: Ran npm test"
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read second\.ts/ })).toBeNull();
  });

  it("does not add a settling caption when completed history first mounts", () => {
    vi.useFakeTimers();
    render(<ToolCallGroupBubble group={buildToolCallGroup([tool("first"), tool("second")])} />);

    expect(screen.getByRole("button", { name: "Read files" })).toBeInTheDocument();
    expect(screen.queryByText("Read second.ts")).toBeNull();
  });

  it("does not add a post-completion delay after an action was visible long enough", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    const first = tool("first");
    const second = tool("second", { status: "running", completedAt: null });
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} />);
    await act(() => vi.advanceTimersByTime(700));

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([{ ...first }, { ...second, status: "done" }])}
      />
    );

    expect(screen.getByRole("button", { name: "Read files" })).toBeInTheDocument();
    expect(screen.queryByText("Read second.ts")).toBeNull();
  });

  it("shows completed results immediately when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    const first = tool("first");
    const second = tool("second", { status: "running", completedAt: null });
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} />);

    rerender(
      <ToolCallGroupBubble
        group={buildToolCallGroup([{ ...first }, { ...second, status: "done" }])}
      />
    );
    const header = screen.getByRole("button", { name: "Read files: Read second.ts" });
    expect(header.parentElement).toHaveAttribute("data-status", "done");
    expect(screen.queryByLabelText("running")).toBeNull();
    fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Read second.ts" }));
    expect(screen.getByText("Contents of second")).toBeInTheDocument();
  });

  it("keeps mixed failures quiet until their details are expanded", () => {
    const failed = tool("failed", { name: "Bash", inputPreview: "npm test", inputFull: { command: "npm test" }, status: "error", error: "Tests failed" });
    render(<ToolCallGroupBubble group={buildToolCallGroup([tool("first"), failed])} />);
    const header = screen.getByRole("button", { name: "Read a file, ran a command" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Tests failed")).not.toBeInTheDocument();
    fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Ran npm test" }));
    expect(screen.getByText("Tests failed")).toBeInTheDocument();
  });

  it("updates expanded output without requiring status or timestamps to change", () => {
    const first = tool("first", { status: "running" });
    const second = tool("second");
    const { rerender } = render(<ToolCallGroupBubble group={buildToolCallGroup([first, second])} defaultExpanded defaultToolsExpanded />);
    expect(screen.getByText("Contents of first")).toBeInTheDocument();
    rerender(<ToolCallGroupBubble group={buildToolCallGroup([{ ...first, output: "More output" }, second])} defaultExpanded defaultToolsExpanded />);
    expect(screen.getByText("More output")).toBeInTheDocument();
  });
});
