import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox.js";

function LightboxHarness(): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setSrc("data:image/png;base64,preview")}>Open preview</button>
      <ImageLightbox src={src} alt="Attached image" onClose={() => setSrc(null)} />
    </>
  );
}

describe("ImageLightbox", () => {
  afterEach(() => cleanup());

  it("moves focus inside, traps Tab, and restores focus on Escape", () => {
    render(<LightboxHarness />);
    const trigger = screen.getByRole("button", { name: "Open preview" });
    trigger.focus();
    fireEvent.click(trigger);

    const close = screen.getByRole("button", { name: "Close image preview" });
    expect(close).toHaveFocus();

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Attached image" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses from the backdrop without treating image clicks as outside", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src="data:image/png;base64,preview"
        alt="Attached image"
        onClose={onClose}
      />
    );

    fireEvent.mouseDown(screen.getByRole("img", { name: "Attached image" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Attached image" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("portals onto the conversation surface so the transcript scroller cannot clip it", () => {
    render(
      <div className="conversation-surface">
        <div style={{ overflow: "hidden", width: 160 }}>
          <LightboxHarness />
        </div>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));

    const dialog = screen.getByRole("dialog", { name: "Attached image" });
    expect(dialog.parentElement).toHaveClass("conversation-surface");
  });
});
