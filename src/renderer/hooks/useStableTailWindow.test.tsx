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
  it("accepts rows that fit while detached, then freezes the current rows at capacity", () => {
    const follow = createFollow();
    const view = render(<Harness items={["a"]} follow={follow} />);
    follow.set(true);
    view.rerender(<Harness items={["a", "b", "c"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c");

    view.rerender(<Harness items={["a", "b", "c", "d"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("a,b,c");
    expect(follow.isDetached()).toBe(true);
  });

  it("renders replacement rows after folding removes the detached window", () => {
    const follow = createFollow();
    const view = render(<Harness items={["a", "b", "c", "d"]} follow={follow} />);
    follow.set(true);
    view.rerender(<Harness items={["e", "f", "g", "h"]} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("f,g,h");
    expect(screen.getByLabelText("Hidden rows")).toHaveTextContent("1");
    expect(follow.isDetached()).toBe(true);
  });

  it("preserves revealed capacity when detached activity folds and reopens", () => {
    const follow = createFollow();
    const items = ["a", "b", "c", "d", "e", "answer"];
    const view = render(<Harness items={items} follow={follow} />);
    follow.set(true);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d,e,answer");

    view.rerender(<Harness items={["answer"]} follow={follow} />);
    view.rerender(<Harness items={items} follow={follow} />);
    expect(screen.getByLabelText("Visible rows")).toHaveTextContent("b,c,d,e,answer");
    expect(follow.isDetached()).toBe(true);
  });

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
