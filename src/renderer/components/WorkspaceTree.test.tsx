import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceTree } from "./WorkspaceTree.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import type { WorkspaceFileEntry } from "../../shared/types.js";

function makeState(entries: WorkspaceFileEntry[]): WorkspaceFilesState {
  return {
    entries,
    listState: "ready",
    listError: null,
    selectedPath: null,
    preview: null,
    previewState: "idle",
    previewError: null,
    openFile: () => undefined
  };
}

describe("WorkspaceTree virtualization", () => {
  it("renders only the visible window for a 10k-file workspace", () => {
    // Flat list of 10k files at the root so they're all visible without
    // expanding any directories — exercises the worst case for row count.
    const entries: WorkspaceFileEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `file-${String(i).padStart(5, "0")}.ts`,
      size: 0
    }));

    render(<WorkspaceTree state={makeState(entries)} height={600} />);

    const rendered = screen.getAllByRole("treeitem");
    // 600px / 24px per row = 25 visible + 16 overscan = ~41 max.
    // Allow comfortable headroom but assert we're nowhere near 10k.
    expect(rendered.length).toBeLessThan(100);
    expect(rendered.length).toBeGreaterThan(10);
  });

  it("renders the empty-state when entries is empty", () => {
    render(<WorkspaceTree state={makeState([])} height={400} />);
    expect(screen.getByText("No files in this workspace.")).toBeTruthy();
  });

  it("renders the visible files as treeitems with their basename", () => {
    const entries: WorkspaceFileEntry[] = [
      { path: "src/app.ts" },
      { path: "src/utils/help.ts" },
      { path: "README.md" }
    ];

    render(<WorkspaceTree state={makeState(entries)} height={400} />);

    // src directory + README.md visible (src not expanded by default).
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });
});
