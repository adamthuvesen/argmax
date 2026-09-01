import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceTree } from "./WorkspaceTree.js";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import type { WorkspaceFileEntry } from "../../shared/types.js";

function makeState(entries: WorkspaceFileEntry[]): WorkspaceFilesState {
  return {
    entries,
    listState: "ready",
    listError: null,
    refreshList: () => undefined,
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
  const nativeResizeObserver = globalThis.ResizeObserver;

  afterEach(() => {
    globalThis.ResizeObserver = nativeResizeObserver;
  });

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

  it("maps filenames and extensions to distinct icons without changing row labels", () => {
    const entries: WorkspaceFileEntry[] = [
      { path: "app.ts" },
      { path: "README.md" },
      { path: "CLAUDE.md" }
    ];

    render(<WorkspaceTree state={makeState(entries)} height={400} />);

    expect(screen.getByRole("treeitem", { name: "app.ts" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "README.md" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "CLAUDE.md" })).toBeVisible();

    const typescriptIcon = screen.getByTitle("File icon for app.ts");
    const markdownIcon = screen.getByTitle("File icon for README.md");
    const claudeIcon = screen.getByTitle("File icon for CLAUDE.md");
    expect(typescriptIcon.innerHTML).not.toBe(markdownIcon.innerHTML);
    expect(claudeIcon.innerHTML).not.toBe(markdownIcon.innerHTML);
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

  it("pins the enclosing folders once their rows scroll out of the window", () => {
    // One deep chain plus enough leaves under it to scroll past the ancestors.
    const entries: WorkspaceFileEntry[] = Array.from({ length: 40 }, (_, i) => ({
      path: `src/renderer/components/File${String(i).padStart(2, "0")}.tsx`
    }));
    const state = { ...makeState(entries), selectedPath: entries[0]?.path ?? null };

    render(<WorkspaceTree state={state} height={240} />);
    const scroller = screen.getByRole("tree");
    // No sticky block at rest: the first row has no ancestor above it.
    expect(document.querySelector(".workspace-tree-sticky")).toBeNull();

    scroller.scrollTop = 240;
    fireEvent.scroll(scroller);

    const sticky = document.querySelector(".workspace-tree-sticky");
    expect(sticky).not.toBeNull();
    // src › renderer › components, outermost first, and hidden from AT because
    // the canonical rows are still in the tree above.
    expect([...(sticky?.querySelectorAll(".workspace-tree-label") ?? [])].map((el) => el.textContent)).toEqual([
      "src",
      "renderer",
      "components"
    ]);
    expect(sticky?.getAttribute("aria-hidden")).toBe("true");
  });

  it("folds every open directory from the toolbar's collapse-all", () => {
    const entries: WorkspaceFileEntry[] = [
      { path: "src/renderer/App.tsx" },
      { path: "README.md" }
    ];
    const state = { ...makeState(entries), selectedPath: "src/renderer/App.tsx" };

    render(<WorkspaceTree state={state} height={400} toolbar={{ onRefresh: () => undefined }} />);
    // selectedPath auto-expanded the chain, so the leaf starts on screen.
    expect(screen.getByText("App.tsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));

    expect(screen.queryByText("App.tsx")).toBeNull();
    expect(screen.queryByText("renderer")).toBeNull();
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("runs the toolbar's refresh action and keeps it off surfaces without one", () => {
    const entries: WorkspaceFileEntry[] = [{ path: "README.md" }];
    const refreshList = vi.fn();

    const { rerender } = render(
      <WorkspaceTree
        state={{ ...makeState(entries), refreshList }}
        height={400}
        toolbar={{ onRefresh: refreshList }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh file list" }));
    expect(refreshList).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceTree state={{ ...makeState(entries), refreshList }} height={400} />);
    expect(screen.queryByRole("button", { name: "Refresh file list" })).toBeNull();
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

  it("measures the container after the loading state resolves", () => {
    // jsdom has no ResizeObserver; this stub reports a tall panel the moment the
    // scroll container is observed.
    const observed: Element[] = [];
    class TallResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.push(target);
        this.callback(
          [{ target, contentRect: { height: 1200 } } as unknown as ResizeObserverEntry],
          this
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TallResizeObserver;

    const loading: WorkspaceFilesState = { ...makeState([]), listState: "loading" };
    const { rerender } = render(<WorkspaceTree state={loading} />);
    expect(observed).toHaveLength(0);

    const entries: WorkspaceFileEntry[] = Array.from({ length: 200 }, (_, i) => ({
      path: `file-${String(i).padStart(3, "0")}.ts`
    }));
    rerender(<WorkspaceTree state={makeState(entries)} />);

    expect(observed).toHaveLength(1);
    // 1200px / 24px per row = 50 rows plus overscan. The 400px seed would cap
    // this at 25, which is what left files cut off below the fold.
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(40);
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
