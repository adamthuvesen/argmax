import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceTree } from "./WorkspaceTree.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import type { WorkspaceFileEntry } from "../../shared/types.js";

function makeState(entries: WorkspaceFileEntry[]): WorkspaceFilesState {
  return {
    entries,
    listState: "ready",
    listError: null,
    tabs: [],
    activeTabPath: null,
    selectedPath: null,
    rootPath: null,
    preview: null,
    previewState: "idle",
    previewError: null,
    openFile: () => undefined,
    selectTab: () => undefined,
    closeTab: () => undefined,
    dirtyClosePrompt: null,
    saveDirtyTabAndClose: () => Promise.resolve(),
    discardDirtyTabAndClose: () => undefined,
    cancelDirtyTabClose: () => undefined,
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

  it("preserves scroll when entries refresh without shape change (audit M19)", () => {
    const entriesA: WorkspaceFileEntry[] = [
      { path: "src/a.ts" },
      { path: "src/b.ts" },
      { path: "src/z.ts" }
    ];
    const entriesB: WorkspaceFileEntry[] = [
      { path: "src/a.ts" },
      { path: "src/c.ts" },
      { path: "src/z.ts" }
    ];

    const { rerender } = render(<WorkspaceTree state={makeState(entriesA)} height={600} />);
    const scroller = screen.getByRole("tree");
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);

    rerender(<WorkspaceTree state={makeState(entriesB)} height={600} />);
    expect(scroller.scrollTop).toBe(120);
  });

  it("auto-expands the ancestors of selectedPath so the row is visible", () => {
    const entries: WorkspaceFileEntry[] = [
      { path: "src/renderer/components/FilePreview.tsx" },
      { path: "src/renderer/components/SessionPane.tsx" },
      { path: "README.md" }
    ];
    const state = { ...makeState(entries), selectedPath: "src/renderer/components/FilePreview.tsx" };

    render(<WorkspaceTree state={state} height={600} />);

    // Ancestors and the selected leaf must all be present.
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("renderer")).toBeTruthy();
    expect(screen.getByText("components")).toBeTruthy();
    expect(screen.getByText("FilePreview.tsx")).toBeTruthy();
  });

  it("does not recenter a selected file when the user expands a folder above it", () => {
    const entries: WorkspaceFileEntry[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ path: `docs/file-${i}.md` })),
      { path: "scripts/build.ts" },
      { path: "AGENTS.md" }
    ];
    const state = { ...makeState(entries), selectedPath: "AGENTS.md" };

    render(<WorkspaceTree state={state} height={72} />);

    const scroller = screen.getByRole("tree");
    expect(scroller.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole("treeitem", { name: "docs" }));

    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByRole("treeitem", { name: "docs" })).toBeVisible();
  });
});
