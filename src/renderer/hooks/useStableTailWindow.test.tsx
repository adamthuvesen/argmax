import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TranscriptFollow } from "./useConversationScroll.js";
import { useStableTailWindow } from "./useStableTailWindow.js";

function createFollow(): TranscriptFollow & { set: (detached: boolean) => void } {
  let detached = false;
  const listeners = new Set<() => void>();
  return {
    isDetached: () => detached,
    newBelowCount: () => 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      detached = next;
      act(() => listeners.forEach((listener) => listener()));
    }
  };
}

let renders = 0;

function Harness({ items, follow }: { items: readonly string[]; follow: TranscriptFollow }) {
  renders += 1;
  const window = useStableTailWindow(items, {
    initialCount: 3,
    pageSize: 2,
    follow,
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
    const follow = createFollow();
    const view = render(<Harness items={["a", "b", "c", "d"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d");

    follow.set(true);
    view.rerender(<Harness items={["a", "b", "c", "d", "e"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d");

    follow.set(false);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("c,d,e");
  });

  it("renders on a follow change only when the mounted rows went stale", () => {
    const follow = createFollow();
    const view = render(<Harness items={["a", "b", "c"]} follow={follow} />);
    renders = 0;

    follow.set(true);
    follow.set(false);
    expect(renders).toBe(0);

    follow.set(true);
    view.rerender(<Harness items={["a", "b", "c", "d"]} follow={follow} />);
    renders = 0;
    follow.set(false);
    expect(renders).toBe(1);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d");
  });

  it("reveals older ids without dropping the retained detached range", () => {
    const follow = createFollow();
    follow.set(true);
    const view = render(<Harness items={["a", "b", "c", "d", "e"]} follow={follow} />);

    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c,d,e");
    expect(screen.getByLabelText("Hidden rows")).toHaveTextContent("0");

    view.rerender(<Harness items={["a", "b", "c", "d", "e", "f"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c,d,e");
  });
});
