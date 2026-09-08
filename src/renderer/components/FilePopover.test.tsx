import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileAutocompleteEntry,
  FileAutocompleteState
} from "../hooks/useFileAutocomplete.js";
import { FilePopover } from "./FilePopover.js";

const ENTRIES: FileAutocompleteEntry[] = [
  { path: "AGENTS.md", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "src", kind: "dir" },
  { path: "src/files/mod.rs", kind: "file" },
  { path: "src/persistence/mod.rs", kind: "file" }
];

function makeState(overrides: Partial<FileAutocompleteState> = {}): FileAutocompleteState {
  return {
    popoverOpen: true,
    filteredEntries: ENTRIES,
    selectionIndex: 0,
    setSelectionIndex: vi.fn(),
    selectEntry: vi.fn(),
    onKeyDown: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides
  };
}

afterEach(cleanup);

describe("FilePopover", () => {
  it("marks the entry at selectionIndex as the selected option", () => {
    render(<FilePopover state={makeState({ selectionIndex: 1 })} inputRef={createRef()} />);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("README.md");
  });

  it("names a nested row by its full path while showing the folder beside the name", () => {
    render(<FilePopover state={makeState()} inputRef={createRef()} />);

    const rows = screen.getAllByRole("option", { name: /mod\.rs$/ });

    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "src/files/mod.rs",
      "src/persistence/mod.rs"
    ]);
    expect(rows[0]).toHaveTextContent("mod.rs");
    expect(rows[0].querySelector('[aria-hidden="true"].file-popover-dir')).toHaveTextContent(
      "src/files"
    );
  });

  it("highlights a row on hover by moving the shared selection index", () => {
    const setSelectionIndex = vi.fn();
    render(
      <FilePopover
        state={makeState({ selectionIndex: 0, setSelectionIndex })}
        inputRef={createRef()}
      />
    );

    fireEvent.mouseMove(screen.getByText("src/"));

    expect(setSelectionIndex).toHaveBeenCalledWith(2);
  });

  it("does not re-set the index when hovering the already-selected row", () => {
    const setSelectionIndex = vi.fn();
    render(
      <FilePopover
        state={makeState({ selectionIndex: 0, setSelectionIndex })}
        inputRef={createRef()}
      />
    );

    fireEvent.mouseMove(screen.getByText("AGENTS.md"));

    expect(setSelectionIndex).not.toHaveBeenCalled();
  });

  it("commits the entry on mouse down", () => {
    const selectEntry = vi.fn();
    render(
      <FilePopover state={makeState({ selectEntry })} inputRef={createRef()} />
    );

    fireEvent.mouseDown(screen.getByText("README.md"));

    expect(selectEntry).toHaveBeenCalledWith({ path: "README.md", kind: "file" });
  });
});
