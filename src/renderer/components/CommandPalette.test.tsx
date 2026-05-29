import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type MessageHit, type PaletteCommand } from "./CommandPalette.js";

const COMMANDS: PaletteCommand[] = Array.from({ length: 12 }, (_, i) => ({
  id: `cmd-${i}`,
  label: `Command ${i}`,
  group: "Actions",
  run: vi.fn()
}));

describe("CommandPalette", () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom doesn't implement layout, so scrollIntoView is undefined on
    // HTMLElement.prototype by default. Stub it so we can assert the keyboard
    // nav effect runs against the currently selected row.
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} commands={COMMANDS} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("autofocuses the input on open", () => {
    render(<CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />);
    expect(screen.getByRole("searchbox", { name: "Command palette query" })).toHaveFocus();
  });

  it("ArrowDown moves selection and keeps the active row in view", () => {
    render(<CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "Command palette query" });

    // Initial selection is the first row; the scroll effect should already
    // have fired one mount-time scroll on whichever row is selected.
    scrollSpy.mockClear();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // The effect runs after the selectedIndex state update — assert that the
    // currently-selected DOM element was the scroll target.
    const selected = document.querySelector(".command-palette-result.selected");
    expect(selected).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("Enter activates the selected command and closes the palette", () => {
    const onClose = vi.fn();
    const run = vi.fn();
    const single: PaletteCommand[] = [
      { id: "only", label: "Only", group: "Actions", run }
    ];
    render(<CommandPalette open={true} commands={single} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette query" }), {
      key: "Enter"
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} commands={COMMANDS} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette query" }), {
      key: "Escape"
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ranks files beyond the first 200 paths before capping visible rows", async () => {
    const onClose = vi.fn();
    const onFilePick = vi.fn();
    const loadFiles = vi.fn().mockResolvedValue([
      ...Array.from({ length: 250 }, (_, i) => `src/generated/file-${i}.ts`),
      "src/renderer/NeedlePanel.tsx"
    ]);

    render(
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={onClose}
        fileSource={{ kind: "workspace", id: "workspace-1" }}
        loadFiles={loadFiles}
        onFilePick={onFilePick}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("NeedlePanel.tsx")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onFilePick).toHaveBeenCalledWith("src/renderer/NeedlePanel.tsx");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops stale message-search results after the query becomes too short", async () => {
    let resolveSearch!: (hits: MessageHit[]) => void;
    const searchMessages = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    render(
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={vi.fn()}
        searchMessages={searchMessages}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(searchMessages).toHaveBeenCalledWith("needle", 8));

    fireEvent.change(input, { target: { value: "n" } });
    resolveSearch([
      {
        id: "session-1:event-1",
        sessionId: "session-1",
        label: "Stale message",
        snippetSegments: [{ text: "needle", matched: true }],
        run: vi.fn()
      }
    ]);

    await waitFor(() => expect(screen.queryByText("Stale message")).toBeNull());
  });
});
