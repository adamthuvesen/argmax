import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildFileTree } from "../lib/fileTree.js";
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
    openFile: () => undefined,
    buffer: null,
    isDirty: false,
    diskMtimeMs: null,
    externalChange: false,
    saveState: "idle",
    saveError: null,
    canEdit: true,
    editFile: () => undefined,
    saveFile: () => Promise.resolve(),
    reloadFile: () => undefined,
    dismissExternalChange: () => undefined
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

  it("builds a 10k-file tree under the perf budget (audit P1.11)", () => {
    // audit-2026-05-11 / SPEC P1.11 — `buildFileTree` previously used an
    // inner `cursor.children.find(...)` for every segment, making the
    // build O(n²) on wide directories. The current implementation uses a
    // per-cursor `Map<segment, TreeNode>` index for O(1) lookups. This
    // test pins that property: 10k entries split into ~3 segments each
    // must build well under 50 ms even on a cold CI runner.
    const entries: WorkspaceFileEntry[] = [];
    for (let dir = 0; dir < 100; dir++) {
      for (let file = 0; file < 100; file++) {
        entries.push({ path: `pkg-${dir}/sub-${dir}/file-${file}.ts` });
      }
    }
    expect(entries).toHaveLength(10_000);

    const start = performance.now();
    const root = buildFileTree(entries);
    const elapsed = performance.now() - start;

    // 100 top-level dirs, each with one sub-dir holding 100 files.
    expect(root.children).toHaveLength(100);
    expect(elapsed).toBeLessThan(50);
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
