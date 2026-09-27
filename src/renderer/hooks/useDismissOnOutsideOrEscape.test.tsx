import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type JSX } from "react";
import { useDismissOnOutsideOrEscape } from "./useDismissOnOutsideOrEscape.js";

function Harness({ close }: { close: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideOrEscape(ref, true, close);
  return <div ref={ref}>Menu</div>;
}

function NestedHarness({ closeParent, closeChild }: { closeParent: () => void; closeChild: () => void }): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideOrEscape(parentRef, true, closeParent);
  useDismissOnOutsideOrEscape(childRef, true, closeChild);
  return (
    <div ref={parentRef}>
      Dialog
      <div ref={childRef}>Dropdown</div>
    </div>
  );
}

describe("useDismissOnOutsideOrEscape", () => {
  afterEach(cleanup);

  it("consumes plain Escape so lower-priority handlers cannot act on the same press", () => {
    const close = vi.fn();
    const lowerPriority = vi.fn();
    window.addEventListener("keydown", lowerPriority);
    try {
      render(<Harness close={close} />);
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(event);

      expect(close).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(lowerPriority).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", lowerPriority);
    }
  });

  it("leaves already-consumed, repeated, composing, and modified Escape alone", () => {
    const close = vi.fn();
    render(<Harness close={close} />);

    const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    consumed.preventDefault();
    document.dispatchEvent(consumed);
    fireEvent.keyDown(document, { key: "Escape", repeat: true });
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "Escape", metaKey: true });

    expect(close).not.toHaveBeenCalled();
  });

  it("dismisses only the innermost active surface", () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    render(<NestedHarness closeParent={closeParent} closeChild={closeChild} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();
  });
});
