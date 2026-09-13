import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableTailWindow } from "./useStableTailWindow.js";

function Harness({ items, detached }: { items: readonly string[]; detached: boolean }) {
  const window = useStableTailWindow(items, {
    initialCount: 3,
    pageSize: 2,
    detached,
    getId: (item) => item
  });
  return (
    <div>
      <output aria-label="Visible rows">{window.visibleItems.join(",")}</output>
      <output aria-label="Hidden rows">{window.hiddenEarlierCount}</output>
      <button type="button" onClick={window.showEarlier}>Show earlier</button>
    </div>
  );
}

describe("useStableTailWindow", () => {
  it("follows the tail until detached, then retains the mounted ids", () => {
    const view = render(<Harness items={["a", "b", "c", "d"]} detached={false} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d");

    view.rerender(<Harness items={["a", "b", "c", "d"]} detached />);
    view.rerender(<Harness items={["a", "b", "c", "d", "e"]} detached />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d");

    view.rerender(<Harness items={["a", "b", "c", "d", "e"]} detached={false} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("c,d,e");
  });

  it("reveals older ids without dropping the retained detached range", () => {
    const view = render(<Harness items={["a", "b", "c", "d", "e"]} detached />);

    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c,d,e");
    expect(screen.getByLabelText("Hidden rows")).toHaveTextContent("0");

    view.rerender(<Harness items={["a", "b", "c", "d", "e", "f"]} detached />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c,d,e");
  });
});
