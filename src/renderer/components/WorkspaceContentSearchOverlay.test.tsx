import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceContentSearchOverlay } from "./WorkspaceContentSearchOverlay.js";
import type { ArgmaxApi, WorkspaceContentSearchResult } from "../../shared/types.js";

const sampleResult: WorkspaceContentSearchResult = {
  files: [
    {
      path: "src/main/index.ts",
      matches: [{ line: 3, preview: "var abc = 1;" }]
    },
    {
      path: "src/renderer/App.tsx",
      matches: [
        { line: 12, preview: "const abc = 'two';" },
        { line: 33, preview: "abc.toUpperCase();" }
      ]
    }
  ],
  truncated: false
};

describe("WorkspaceContentSearchOverlay", () => {
  let grepContent: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["grepContent"]>>;

  beforeEach(() => {
    grepContent = vi.fn<ArgmaxApi["workspace"]["grepContent"]>().mockResolvedValue(sampleResult);
    (window as { argmax?: unknown }).argmax = { workspace: { grepContent } };
  });

  afterEach(() => {
    delete (window as { argmax?: unknown }).argmax;
  });

  it("returns null when closed", () => {
    const { container } = render(
      <WorkspaceContentSearchOverlay
        open={false}
        onClose={() => {}}
        source={{ kind: "workspace", id: "ws-1" }}
        onPick={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("debounces, calls grepContent, and renders file-grouped hits", async () => {
    render(
      <WorkspaceContentSearchOverlay
        open
        onClose={() => {}}
        source={{ kind: "workspace", id: "ws-1" }}
        onPick={() => {}}
      />
    );
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "var abc" } });

    // Real timers — wait for the 180ms internal debounce to fire.
    await waitFor(() =>
      expect(grepContent).toHaveBeenCalledWith({
        kind: "workspace",
        id: "ws-1",
        query: "var abc"
      })
    );

    expect(await screen.findByText("src/main/index.ts")).toBeInTheDocument();
    expect(screen.getByText("var abc = 1;")).toBeInTheDocument();
    expect(screen.getByText("src/renderer/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("abc.toUpperCase();")).toBeInTheDocument();
  });

  it("commits via onPick + onClose when a result row is clicked", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceContentSearchOverlay
        open
        onClose={onClose}
        source={{ kind: "workspace", id: "ws-1" }}
        onPick={onPick}
      />
    );
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "var abc" } });

    fireEvent.mouseDown(await screen.findByText("src/main/index.ts"));
    expect(onPick).toHaveBeenCalledWith("src/main/index.ts");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables the input and shows guidance when no source is registered", () => {
    render(
      <WorkspaceContentSearchOverlay open onClose={() => {}} source={null} onPick={null} />
    );
    const input = screen.getByRole("searchbox");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((input as HTMLInputElement).placeholder).toMatch(/open a project/i);
  });
});
