import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFolderChangesState } from "../hooks/useProjectFolderChanges.js";
import { ProjectFolderChangesList } from "./ProjectFolderChanges.js";

function stateStub(): ProjectFolderChangesState {
  return {
    workingFolder: null,
    groups: [{
      folder: { id: "context", projectId: "project", name: "primary", rootPath: "/repos/context", isPrimary: true, enabled: true, summary: null },
      files: [
        { path: "src/search/index.ts", status: "modified", additions: 1, deletions: 2, staged: false },
        { path: "src/api/index.ts", status: "modified", additions: 3, deletions: 4, staged: false }
      ],
      error: null
    }],
    error: null,
    selection: null,
    selectedFolder: null,
    diff: null,
    diffError: null,
    loadingDiff: false,
    selectFile: vi.fn(),
    clearSelection: vi.fn(),
    refresh: vi.fn(),
    expandContext: vi.fn()
  };
}

afterEach(cleanup);

describe("ProjectFolderChangesList", () => {
  it("keeps full paths distinct when filenames match and selects the matching folder diff", () => {
    const state = stateStub();
    state.selection = { folderId: "context", path: "src/search/index.ts" };
    render(<ProjectFolderChangesList state={state} />);

    expect(screen.getByText("context")).toBeVisible();
    expect(screen.getByText("2 files")).toBeVisible();
    expect(screen.getAllByText("index.ts")).toHaveLength(2);
    expect(screen.getByText("src/search")).toBeVisible();
    expect(screen.getByRole("button", { name: "View src/search/index.ts in context" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "View src/api/index.ts in context" }));
    expect(state.selectFile).toHaveBeenCalledWith("context", "src/api/index.ts");
  });

  it("starts unchanged folders collapsed and names the empty state", () => {
    const state = stateStub();
    state.groups[0].files = [];
    render(<ProjectFolderChangesList state={state} />);

    expect(screen.getByText("No changes")).toBeVisible();
    expect(screen.getByText("context").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("distinguishes a failed folder read from an unchanged folder", () => {
    const state = stateStub();
    state.groups[0].files = [];
    state.groups[0].error = "Repository unavailable";
    render(<ProjectFolderChangesList state={state} />);

    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Could not load changes: Repository unavailable");
    expect(screen.queryByText("No changes")).not.toBeInTheDocument();
  });
});
