import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSearchOverlay } from "./FileSearchOverlay.js";

type ListFilesMock = ReturnType<typeof vi.fn>;

function installBridge(listFilesForProject: ListFilesMock): void {
  (window as unknown as { argmax: unknown }).argmax = {
    workspace: {
      listFiles: vi.fn(),
      listFilesForProject
    }
  };
}

beforeEach(() => {
  installBridge(vi.fn().mockResolvedValue([
    { path: "src/a.ts" },
    { path: "src/b.tsx" },
    { path: "docs/c.md" }
  ]));
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: unknown }).argmax;
});

describe("FileSearchOverlay", () => {
  it("returns null when closed", () => {
    const { container } = render(
      <FileSearchOverlay
        open={false}
        onClose={vi.fn()}
        sourceKind="project"
        sourceId="p1"
        onPick={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("loads files on open and filters by basename as the user types", async () => {
    render(
      <FileSearchOverlay
        open={true}
        onClose={vi.fn()}
        sourceKind="project"
        sourceId="p1"
        onPick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("a.ts")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Search files…"), { target: { value: "b" } });

    await waitFor(() => {
      expect(screen.queryByText("a.ts")).toBeNull();
      expect(screen.getByText("b.tsx")).toBeTruthy();
    });
  });

  it("calls onPick + onClose when the user presses Enter on a result", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FileSearchOverlay
        open={true}
        onClose={onClose}
        sourceKind="project"
        sourceId="p1"
        onPick={onPick}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("a.ts")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toBe("src/a.ts");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <FileSearchOverlay
        open={true}
        onClose={onClose}
        sourceKind="project"
        sourceId="p1"
        onPick={vi.fn()}
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on click-outside the modal", () => {
    const onClose = vi.fn();
    render(
      <FileSearchOverlay
        open={true}
        onClose={onClose}
        sourceKind="project"
        sourceId="p1"
        onPick={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the workspace IPC when sourceKind is workspace", async () => {
    const listFiles = vi.fn().mockResolvedValue([{ path: "src/x.ts" }]);
    (window as unknown as { argmax: unknown }).argmax = {
      workspace: { listFiles, listFilesForProject: vi.fn() }
    };

    render(
      <FileSearchOverlay
        open={true}
        onClose={vi.fn()}
        sourceKind="workspace"
        sourceId="w1"
        onPick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(listFiles).toHaveBeenCalledWith("w1");
      expect(screen.getByText("x.ts")).toBeTruthy();
    });
  });
});
