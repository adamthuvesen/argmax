import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardCheatSheet } from "./KeyboardCheatSheet.js";

describe("KeyboardCheatSheet", () => {
  afterEach(() => cleanup());

  it("renders nothing when closed", () => {
    const onClose = vi.fn();
    render(<KeyboardCheatSheet open={false} onClose={onClose} />);
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("focuses the close button on open so keyboard users land inside the dialog", () => {
    const onClose = vi.fn();
    render(<KeyboardCheatSheet open={true} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes on Escape even when focus is in a typing target outside the dialog", () => {
    const onClose = vi.fn();
    // External textarea simulating the chat composer holding focus when the
    // cheat sheet is opened via the native menu. Previously useOverlays's
    // typing-target guard kept Esc inside the textarea instead of dismissing
    // the cheat sheet.
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    try {
      render(<KeyboardCheatSheet open={true} onClose={onClose} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(textarea);
    }
  });

  it("closes on outside (overlay) mousedown", () => {
    const onClose = vi.fn();
    render(<KeyboardCheatSheet open={true} onClose={onClose} />);
    // mousedown on the overlay backdrop (outside the inner .cheat-sheet ref)
    const overlay = document.querySelector(".cheat-sheet-overlay") as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element on close", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open cheat sheet";
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { rerender } = render(<KeyboardCheatSheet open={true} onClose={onClose} />);
      // Now the close button is focused.
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      rerender(<KeyboardCheatSheet open={false} onClose={onClose} />);
      expect(trigger).toHaveFocus();
    } finally {
      document.body.removeChild(trigger);
    }
  });
});
