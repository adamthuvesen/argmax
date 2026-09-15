import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangesTree, type ChangesTreeProps } from "./ChangesTree.js";
import type { ChangedFileSummary } from "../../shared/types.js";

function makeFile(overrides: Partial<ChangedFileSummary> & { path: string }): ChangedFileSummary {
  return {
    status: " M",
    additions: 3,
    deletions: 2,
    staged: false,
    ...overrides
  };
}

function renderTree(props: Partial<ChangesTreeProps> & { files: ChangedFileSummary[] }) {
  const merged: ChangesTreeProps = {
    selectedPath: null,
    onSelectFile: () => undefined,
    onRefresh: () => undefined,
    onOpenInFiles: () => undefined,
    ...props
  };
  return { ...render(<ChangesTree {...merged} />), props: merged };
}

describe("ChangesTree", () => {
  it("folds a single-child directory chain into one row that still toggles the deepest folder", () => {
    renderTree({
      files: [makeFile({ path: "src/renderer/components/ChangesTree.tsx" })]
    });

    const chain = screen.getByRole("treeitem", { name: "src/renderer/components" });
    // The canonical path survives folding, so ancestor reveal and toggling agree.
    expect(chain.getAttribute("title")).toBe("src/renderer/components");
    expect(screen.queryByRole("treeitem", { name: "renderer" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "ChangesTree.tsx" })).toBeVisible();

    fireEvent.click(chain);
    expect(screen.queryByRole("treeitem", { name: "ChangesTree.tsx" })).toBeNull();
  });

  it("keeps a directory that also holds a file on its own row", () => {
    renderTree({
      files: [makeFile({ path: "src/index.ts" }), makeFile({ path: "src/lib/util.ts" })]
    });

    expect(screen.getByRole("treeitem", { name: "src" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "lib" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeVisible();
  });

  it("derives status from the line mix, not the git status code", () => {
    renderTree({
      files: [
        makeFile({ path: "added.ts", status: " M", additions: 12, deletions: 0 }),
        makeFile({ path: "gone.ts", status: " M", additions: 0, deletions: 1 }),
        makeFile({ path: "touched.ts", status: "A ", additions: 4, deletions: 6 })
      ]
    });

    expect(screen.getByRole("img", { name: "Added, 12 insertions, 0 deletions" }).textContent).toBe("+");
    expect(screen.getByRole("img", { name: "Deleted, 0 insertions, 1 deletion" }).textContent).toBe("−");
    expect(screen.getByRole("img", { name: "Modified, 4 insertions, 6 deletions" }).textContent).toBe("·");
  });

  it("marks a deleted file's label through data-status rather than an inline style", () => {
    renderTree({ files: [makeFile({ path: "gone.ts", additions: 0, deletions: 9 })] });

    const row = screen.getByRole("treeitem", { name: "gone.ts" });
    const label = row.querySelector(".changes-tree-label");
    expect(label?.getAttribute("data-status")).toBe("deleted");
    expect(label?.getAttribute("style")).toBeNull();
  });

  it("reports the selected row and passes clicks through as paths", () => {
    const onSelectFile = vi.fn();
    renderTree({
      files: [makeFile({ path: "src/a.ts" }), makeFile({ path: "src/b.ts" })],
      selectedPath: "src/b.ts",
      onSelectFile
    });

    expect(screen.getByRole("treeitem", { name: "b.ts" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "a.ts" }).getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("treeitem", { name: "a.ts" }));
    expect(onSelectFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("starts expanded, folds everything from the toolbar, and reveals a newly selected file", () => {
    const { rerender, props } = renderTree({
      files: [makeFile({ path: "src/lib/deep.ts" }), makeFile({ path: "README.md" })]
    });

    expect(screen.getByRole("treeitem", { name: "deep.ts" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));
    expect(screen.queryByRole("treeitem", { name: "deep.ts" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "README.md" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse all folders" })).toBeDisabled();

    rerender(<ChangesTree {...props} selectedPath="src/lib/deep.ts" />);
    expect(screen.getByRole("treeitem", { name: "deep.ts" })).toBeVisible();
  });

  it("runs the toolbar refresh", () => {
    const onRefresh = vi.fn();
    renderTree({ files: [makeFile({ path: "a.ts" })], onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Refresh changed files" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("routes row actions to their own callbacks without selecting the row", () => {
    const onSelectFile = vi.fn();
    const onToggleStaged = vi.fn();
    const onRevert = vi.fn();
    const onOpenInFiles = vi.fn();
    const file = makeFile({ path: "src/a.ts", staged: true });
    renderTree({ files: [file], onSelectFile, onToggleStaged, onRevert, onOpenInFiles });

    fireEvent.click(screen.getByRole("button", { name: "Unstage src/a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert unstaged changes in src/a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts in Files view" }));

    expect(onToggleStaged).toHaveBeenCalledWith(file);
    expect(onRevert).toHaveBeenCalledWith(file);
    expect(onOpenInFiles).toHaveBeenCalledWith("src/a.ts");
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it("hides staging and revert when the caller withholds them, and keeps revert off untracked files", () => {
    const { rerender, props } = renderTree({
      files: [makeFile({ path: "new.ts", status: "??", additions: 5, deletions: 0 })],
      onToggleStaged: () => undefined,
      onRevert: () => undefined
    });

    expect(screen.getByRole("button", { name: "Stage new.ts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revert unstaged changes in new.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open new.ts in Files view" })).toBeVisible();

    rerender(<ChangesTree {...props} onToggleStaged={undefined} onRevert={undefined} />);
    expect(screen.queryByRole("button", { name: "Stage new.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open new.ts in Files view" })).toBeVisible();
  });

  it("disables write actions while a review action is pending but leaves open-in-files alive", () => {
    renderTree({
      files: [makeFile({ path: "a.ts" })],
      onToggleStaged: () => undefined,
      onRevert: () => undefined,
      actionsPending: true
    });

    expect(screen.getByRole("button", { name: "Stage a.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert unstaged changes in a.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open a.ts in Files view" })).toBeEnabled();
  });
});
