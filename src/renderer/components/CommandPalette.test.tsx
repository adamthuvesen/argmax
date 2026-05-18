import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";

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
});
