import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlighter.js", () => ({
  highlightLine: vi.fn((content: string) => [{ content }]),
  useHighlighterReady: vi.fn(() => true),
  langFromPath: vi.fn(() => null)
}));

import type { ReviewState } from "../hooks/useReviewState.js";
import {
  activateReviewMode,
  closeReviewPane,
  setReviewPaneMode,
  setReviewSplitRatio,
  splitReviewMode,
  type ReviewLayout
} from "../lib/reviewLayout.js";
import { resetTerminalTabsForTests } from "../lib/terminalTabs.js";
import { reviewStub as baseReviewStub } from "../../test/reviewFixture.js";
import { ReviewPanel } from "./ReviewPanel.js";

function reviewStub(overrides: Partial<ReviewState> = {}): ReviewState {
  return baseReviewStub({
    files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
    selectedFilePath: "src/a.ts",
    diff: { workspaceId: "workspace-1", filePath: "src/a.ts", content: "@@ -1,1 +1,1 @@\n-old\n+new\n" },
    diffState: "ready",
    isPanelOpen: true,
    terminalWorkspaceId: "workspace-1",
    ...overrides
  });
}

interface ReviewHarnessProps {
  closeFileTab?: (path: string) => void;
  initialLayout: ReviewLayout;
}

function ReviewHarness({ closeFileTab = () => {}, initialLayout }: ReviewHarnessProps): JSX.Element {
  const [layout, setLayout] = useState(initialLayout);
  const review = reviewStub({
    layout,
    mode: layout.modes[layout.activeIndex],
    setMode: (mode) => setLayout((current) => activateReviewMode(current, mode)),
    setPaneMode: (index, mode) => setLayout((current) => setReviewPaneMode(current, index, mode)),
    focusPane: (index) => setLayout((current) => ({ ...current, activeIndex: index })),
    splitMode: (mode, position) => setLayout((current) => splitReviewMode(current, mode, position)),
    closePane: (index) => setLayout((current) => closeReviewPane(current, index)),
    setSplitRatio: (ratio) => setLayout((current) => setReviewSplitRatio(current, ratio)),
    workspaceFiles: {
      ...baseReviewStub().workspaceFiles,
      listState: "ready",
      entries: [{ path: "src/index.ts" }],
      tabs: [{ path: "src/index.ts", isDirty: false, saveState: "idle", externalChange: false }],
      activeTabPath: "src/index.ts",
      selectedPath: "src/index.ts",
      closeTab: closeFileTab
    }
  });
  return <ReviewPanel review={review} />;
}

function dragTransfer(seed: Record<string, string> = {}): DataTransfer {
  const values = new Map(Object.entries(seed));
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    get types() {
      return [...values.keys()];
    },
    clearData(format?: string) {
      if (format) values.delete(format);
      else values.clear();
    },
    getData(format: string) {
      return values.get(format) ?? "";
    },
    setData(format: string, data: string) {
      values.set(format, data);
    },
    setDragImage: vi.fn()
  };
}

function selectedMode(pane: HTMLElement, mode: string): HTMLElement {
  return within(pane).getByRole("tab", { name: mode, selected: true });
}

function pointerEvent(type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

describe("ReviewPanel split view", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTerminalTabsForTests();
  });

  afterEach(() => {
    cleanup();
    resetTerminalTabsForTests();
    vi.restoreAllMocks();
  });

  it("splits from a tab context menu and marks the menu as a browser overlay", () => {
    render(<ReviewHarness initialLayout={{ modes: ["changes"], activeIndex: 0, ratio: 0.5 }} />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Changes" }), { clientX: 40, clientY: 20 });
    const menu = screen.getByRole("menu", { name: "Changes tab actions" });
    expect(menu).toHaveAttribute("data-browser-overlay", "true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Split below" }));

    expect(selectedMode(screen.getByLabelText("Top review pane"), "Changes")).toBeInTheDocument();
    expect(selectedMode(screen.getByLabelText("Bottom review pane"), "Files")).toBeInTheDocument();
  });

  it("opens the tab context menu from the keyboard", () => {
    render(<ReviewHarness initialLayout={{ modes: ["changes"], activeIndex: 0, ratio: 0.5 }} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "F10", shiftKey: true });

    expect(screen.getByRole("menu", { name: "Files tab actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Split below" })).toHaveFocus();
  });

  it("keeps keyboard focus on the selected tab when its keyed pane changes mode", () => {
    render(<ReviewHarness initialLayout={{ modes: ["changes"], activeIndex: 0, ratio: 0.5 }} />);
    const filesTab = screen.getByRole("tab", { name: "Files" });
    filesTab.focus();

    fireEvent.click(filesTab);

    expect(screen.getByRole("tab", { name: "Files", selected: true })).toHaveFocus();
  });

  it("lets either pane close and expands the survivor", () => {
    const initialLayout: ReviewLayout = { modes: ["changes", "files"], activeIndex: 1, ratio: 0.5 };
    const top = render(<ReviewHarness initialLayout={initialLayout} />);

    fireEvent.click(screen.getByRole("button", { name: "Close top pane" }));
    expect(screen.queryByLabelText("Top review pane")).not.toBeInTheDocument();
    expect(selectedMode(screen.getByLabelText("Review panel content"), "Files")).toBeInTheDocument();

    top.unmount();
    render(<ReviewHarness initialLayout={initialLayout} />);
    fireEvent.click(screen.getByRole("button", { name: "Close bottom pane" }));
    expect(screen.queryByLabelText("Bottom review pane")).not.toBeInTheDocument();
    expect(selectedMode(screen.getByLabelText("Review panel content"), "Changes")).toBeInTheDocument();
  });

  it("splits on an internal tab drop and ignores file or external drags", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
      height: 400,
      left: 0,
      right: 600,
      top: 0,
      width: 600,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    render(<ReviewHarness initialLayout={{ modes: ["changes"], activeIndex: 0, ratio: 0.5 }} />);
    const dropTarget = screen.getByRole("group", { name: "Review panes" });

    fireEvent.dragOver(dropTarget, { clientY: 350, dataTransfer: dragTransfer({ Files: "" }) });
    fireEvent.drop(dropTarget, { clientY: 350, dataTransfer: dragTransfer({ Files: "" }) });
    fireEvent.dragOver(dropTarget, { clientY: 350, dataTransfer: dragTransfer({ "text/plain": "Files" }) });
    fireEvent.drop(dropTarget, { clientY: 350, dataTransfer: dragTransfer({ "text/plain": "Files" }) });
    expect(screen.queryByLabelText("Bottom review pane")).not.toBeInTheDocument();

    const transfer = dragTransfer();
    fireEvent.dragStart(screen.getByRole("tab", { name: "Files" }), { dataTransfer: transfer });
    fireEvent.dragOver(dropTarget, { clientY: 350, dataTransfer: transfer });
    expect(screen.getByRole("status")).toHaveTextContent("Show Files below");
    fireEvent.drop(dropTarget, { clientY: 350, dataTransfer: transfer });

    expect(selectedMode(screen.getByLabelText("Top review pane"), "Changes")).toBeInTheDocument();
    expect(selectedMode(screen.getByLabelText("Bottom review pane"), "Files")).toBeInTheDocument();
  });

  it("resizes the panes by pointer and keyboard with an accessible percentage", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
      height: 400,
      left: 0,
      right: 600,
      top: 0,
      width: 600,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    render(<ReviewHarness initialLayout={{ modes: ["changes", "files"], activeIndex: 0, ratio: 0.5 }} />);
    const separator = screen.getByRole("separator", { name: "Resize review panes" });
    expect(separator).toHaveAttribute("aria-valuemin", "20");
    expect(separator).toHaveAttribute("aria-valuemax", "80");
    expect(separator).toHaveAttribute("aria-valuenow", "50");

    fireEvent.pointerDown(separator, { clientY: 200, pointerId: 1 });
    fireEvent(document, pointerEvent("pointermove", 260));
    fireEvent(document, pointerEvent("pointerup", 260));
    const afterPointer = Number(separator.getAttribute("aria-valuenow"));
    expect(afterPointer).toBeGreaterThan(50);

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator).toHaveAttribute("aria-valuenow", String(afterPointer + 5));
  });

  it("keeps one terminal DOM host across both panes", async () => {
    const { container } = render(
      <ReviewHarness initialLayout={{ modes: ["terminal", "changes"], activeIndex: 1, ratio: 0.5 }} />
    );

    await waitFor(() => expect(container.querySelectorAll(".review-terminal-mount")).toHaveLength(1));
  });

  it("routes file shortcuts only from the focused pane", () => {
    const closeFileTab = vi.fn();
    render(
      <ReviewHarness
        closeFileTab={closeFileTab}
        initialLayout={{ modes: ["files", "changes"], activeIndex: 0, ratio: 0.5 }}
      />
    );

    fireEvent.pointerDown(screen.getByLabelText("Bottom review pane"));
    fireEvent.keyDown(selectedMode(screen.getByLabelText("Bottom review pane"), "Changes"), {
      key: "w",
      metaKey: true
    });
    expect(closeFileTab).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByLabelText("Top review pane"));
    fireEvent.keyDown(within(screen.getByLabelText("Top review pane")).getByRole("tab", { name: /index\.ts/ }), {
      key: "w",
      metaKey: true
    });
    expect(closeFileTab).toHaveBeenCalledWith("src/index.ts");
  });
});
