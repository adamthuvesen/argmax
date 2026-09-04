import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderSwitchDialog } from "./ProviderSwitchDialog.js";

function DialogHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="conversation-surface">
      <button type="button" onClick={() => setOpen(true)}>Change provider</button>
      {open ? (
        <ProviderSwitchDialog
          from="codex"
          to="claude"
          onCancel={() => setOpen(false)}
          onStartNewSession={() => setOpen(false)}
          onSwitch={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

describe("ProviderSwitchDialog", () => {
  afterEach(() => cleanup());

  it("contains keyboard focus and returns it to the trigger after Escape", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Change provider" });
    trigger.focus();
    fireEvent.click(trigger);

    const primary = await screen.findByRole("button", { name: "New chat" });
    expect(primary).toHaveFocus();

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch this chat to Claude" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses when the pane backdrop is pressed", async () => {
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Change provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch this chat to Claude" });

    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole("dialog", { name: "Switch this chat to Claude" })).toBeNull();
  });
});
