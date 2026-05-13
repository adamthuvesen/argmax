import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    isSummaryCollapsed: true,
    mode: "changes",
    setMode: vi.fn(),
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      selectedPath: null,
      preview: null,
      previewState: "idle",
      previewError: null,
      openFile: vi.fn()
    },
    openFile: vi.fn(),
    openPanelInFilesMode: vi.fn(),
    closePanel: vi.fn(),
    togglePanel: vi.fn(),
    toggleSummary: vi.fn()
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
    fireEvent.mouseDown(screen.getByRole("separator", { name: "Resize file list" }), {
      clientY: 120
    });
    expect(document.body.style.cursor).toBe("ns-resize");
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
