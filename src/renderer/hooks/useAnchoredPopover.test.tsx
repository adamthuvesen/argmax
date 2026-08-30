import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAnchoredPopover } from "./useAnchoredPopover.js";

function Popover({ open = true }: { open?: boolean }): React.JSX.Element {
  const popover = useAnchoredPopover({ open });
  return (
    <div ref={popover.setAnchor}>
      <button type="button">anchor</button>
      {open ? (
        <ul ref={popover.setPopover} style={popover.floatingStyles} aria-label="menu">
          <li>item</li>
        </ul>
      ) : null}
    </div>
  );
}

describe("useAnchoredPopover", () => {
  // Every popover stylesheet in the app predates this hook and still names the
  // side it used to open on — `.project-picker-popover` opens upward with
  // `bottom: calc(100% + 6px)`. Floating UI writes only `top`/`left`, so
  // leaving those in place over-constrains the box: the browser stops sizing it
  // by its content and derives the height from the containing block instead,
  // collapsing a full menu to its padding.
  it("clears the far edges so the stylesheet cannot over-constrain the box", () => {
    render(<Popover />);
    expect(screen.getByLabelText("menu")).toHaveStyle({ bottom: "auto", right: "auto" });
  });

  it("positions the popover out of flow", () => {
    render(<Popover />);
    expect(screen.getByLabelText("menu")).toHaveStyle({ position: "fixed" });
  });
});
