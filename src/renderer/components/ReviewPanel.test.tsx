import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the highlighter so this test never touches shiki.
vi.mock("../lib/highlighter.js", () => ({
  highlightLine: vi.fn((content: string) => [{ content }]),
  useHighlighterReady: vi.fn(() => true),
  langFromPath: vi.fn(() => null)
}));

import type { ReviewState } from "../hooks/useReviewState.js";
import { ReviewPanel } from "./ReviewPanel.js";

function reviewStub(): ReviewState {
  return {
    files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
    filesState: "ready",
    filesError: null,
    selectedFilePath: "src/a.ts",
    diff: {
      workspaceId: "workspace-1",
      filePath: "src/a.ts",
      content: "@@ -1,1 +1,1 @@\n-old\n+new\n"
    },
    diffState: "ready",
    diffError: null,
    isPanelOpen: true,
    mode: "changes",
    setMode: vi.fn(),
    changesComparison: "local",
    setChangesComparison: vi.fn(),
    comparisonBaseLabel: "main",
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      tabs: [],
      activeTabPath: null,
      selectedPath: null,
      rootPath: null,
      preview: null,
      previewState: "idle",
      previewError: null,
      openFile: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      dirtyClosePrompt: null,
      saveDirtyTabAndClose: vi.fn().mockResolvedValue(undefined),
      discardDirtyTabAndClose: vi.fn(),
      cancelDirtyTabClose: vi.fn(),
      buffer: null,
      isDirty: false,
      diskMtimeMs: null,
      externalChange: false,
      saveState: "idle",
      saveError: null,
      canEdit: true,
      editFile: vi.fn(),
      saveFile: vi.fn().mockResolvedValue(undefined),
      reloadFile: vi.fn(),
      dismissExternalChange: vi.fn()
    },
    openFile: vi.fn(),
    openPanelInFilesMode: vi.fn(),
    openInFilesView: vi.fn(),
    closePanel: vi.fn(),
    togglePanel: vi.fn(),
    toggleChangesPanel: vi.fn()
  };
}

describe("ReviewPanel side-by-side toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("starts in unified mode, flips DOM to side-by-side on toggle, and round-trips via localStorage", () => {
    const { container, unmount } = render(<ReviewPanel review={reviewStub()} />);

    expect(container.querySelector(".diff-side-by-side")).toBeNull();
    expect(container.querySelector(".diff-sbs-grid")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Switch to side-by-side diff" }));

    expect(container.querySelector(".diff-side-by-side")).not.toBeNull();
    expect(container.querySelector(".diff-sbs-grid")).not.toBeNull();
    expect(window.localStorage.getItem("argmax.diffView")).toBe("side-by-side");

    unmount();
    cleanup();

    // Mount a fresh instance — preference should hydrate from localStorage.
    const next = render(<ReviewPanel review={reviewStub()} />);
    expect(next.container.querySelector(".diff-sbs-grid")).not.toBeNull();
  });
});

describe("ReviewPanel side-by-side layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders file list and diff as siblings inside .review-body with an inline width on the left column", () => {
    const { container } = render(<ReviewPanel review={reviewStub()} />);
    const body = container.querySelector(".review-body");
    const leftCol = container.querySelector<HTMLElement>(".review-list-col");
    const diff = container.querySelector(".review-diff");

    expect(body).not.toBeNull();
    expect(leftCol).not.toBeNull();
    expect(diff).not.toBeNull();
    expect(body?.contains(leftCol)).toBe(true);
    expect(body?.contains(diff)).toBe(true);
    expect(leftCol?.style.width).toMatch(/px$/);
  });

  it("persists left column width to localStorage when the handle is dragged", () => {
    render(<ReviewPanel review={reviewStub()} />);
    const handle = screen.getByRole("separator", { name: "Resize file list width" });

    fireEvent.mouseDown(handle, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 700 });
    fireEvent.mouseUp(document);

    const stored = window.localStorage.getItem("argmax.reviewPanel.leftColumnWidth");
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(200);
  });
});

describe("ReviewPanel file tabs", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders open files as an accessible tab strip and routes tab actions", () => {
    const review = reviewStub();
    const selectTab = vi.fn();
    const closeTab = vi.fn();
    review.mode = "files";
    review.workspaceFiles = {
      ...review.workspaceFiles,
      tabs: [
        { path: "src/index.ts", isDirty: true, saveState: "idle", externalChange: false },
        { path: "src/utils.ts", isDirty: false, saveState: "idle", externalChange: false }
      ],
      activeTabPath: "src/index.ts",
      selectedPath: "src/index.ts",
      selectTab,
      closeTab
    };

    render(<ReviewPanel review={review} />);

    const tablist = screen.getByRole("tablist", { name: "Open files" });
    expect(within(tablist).getByRole("tab", { name: /index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.click(within(tablist).getByRole("tab", { name: "utils.ts" }));
    expect(selectTab).toHaveBeenCalledWith("src/utils.ts");

    fireEvent.click(screen.getByRole("button", { name: "Close src/index.ts" }));
    expect(closeTab).toHaveBeenCalledWith("src/index.ts");
  });

  it("shows the dirty-close prompt with save, discard, and cancel actions", () => {
    const review = reviewStub();
    const saveDirtyTabAndClose = vi.fn().mockResolvedValue(undefined);
    const discardDirtyTabAndClose = vi.fn();
    const cancelDirtyTabClose = vi.fn();
    review.mode = "files";
    review.workspaceFiles = {
      ...review.workspaceFiles,
      tabs: [{ path: "src/index.ts", isDirty: true, saveState: "idle", externalChange: false }],
      activeTabPath: "src/index.ts",
      selectedPath: "src/index.ts",
      dirtyClosePrompt: { path: "src/index.ts" },
      saveDirtyTabAndClose,
      discardDirtyTabAndClose,
      cancelDirtyTabClose
    };

    render(<ReviewPanel review={review} />);

    expect(screen.getByRole("alert", { name: "Unsaved changes in src/index.ts" })).toHaveTextContent(
      "Save changes to index.ts?"
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveDirtyTabAndClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardDirtyTabAndClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelDirtyTabClose).toHaveBeenCalled();
  });

  it("routes Cmd+W to the active file tab while Files mode has a tab open", () => {
    const review = reviewStub();
    const closeTab = vi.fn();
    review.mode = "files";
    review.workspaceFiles = {
      ...review.workspaceFiles,
      tabs: [{ path: "src/index.ts", isDirty: false, saveState: "idle", externalChange: false }],
      activeTabPath: "src/index.ts",
      selectedPath: "src/index.ts",
      closeTab
    };

    render(<ReviewPanel review={review} />);

    const wasNotCanceled = fireEvent.keyDown(document, { key: "w", metaKey: true });

    expect(wasNotCanceled).toBe(false);
    expect(closeTab).toHaveBeenCalledWith("src/index.ts");
  });

  it("leaves Cmd+W alone in Files mode when no file tab is open", () => {
    const review = reviewStub();
    const closeTab = vi.fn();
    review.mode = "files";
    review.workspaceFiles = {
      ...review.workspaceFiles,
      closeTab
    };

    render(<ReviewPanel review={review} />);

    const wasNotCanceled = fireEvent.keyDown(document, { key: "w", metaKey: true });

    expect(wasNotCanceled).toBe(true);
    expect(closeTab).not.toHaveBeenCalled();
  });
});

/**
 * audit-2026-05-11 / SPEC P1.10 — mid-drag unmount used to leave document
 * mousemove/mouseup listeners attached and the body cursor frozen at
 * `ns-resize`. The fix tracks the active drag in a ref; the unmount effect
 * replays the cleanup so listeners detach and body styles reset.
 */
describe("ReviewPanel — drag listener cleanup on unmount", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    cleanup();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("removes document listeners and resets body styles when unmounted mid-drag", () => {
    const removeListener = vi.spyOn(document, "removeEventListener");

    const { unmount } = render(<ReviewPanel review={reviewStub()} />);

    // Start a drag: mousedown on the resize handle activates the cursor
    // grab and registers two document-level listeners.
    fireEvent.mouseDown(screen.getByRole("separator", { name: "Resize file list width" }), {
      clientX: 120
    });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    // Mid-drag unmount — without the cleanup ref, listeners would survive.
    unmount();

    // Body styles must be reset to whatever they were before the drag.
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    // Both mousemove and mouseup listeners were detached by the cleanup.
    const detached = removeListener.mock.calls.map(([eventName]) => eventName);
    expect(detached).toContain("mousemove");
    expect(detached).toContain("mouseup");

    removeListener.mockRestore();
  });
});
