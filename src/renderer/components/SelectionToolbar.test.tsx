import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRef } from "react";
import { SelectionToolbar } from "./SelectionToolbar.js";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

it("consumes Escape only while a selection toolbar is open", () => {
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    return <><div ref={ref}>Selected response</div><SelectionToolbar containerRef={ref} onAddToChat={() => undefined} /></>;
  }
  render(<Probe />);
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("Selected response"));
  Object.defineProperty(range, "getBoundingClientRect", { value: () => new DOMRect(20, 50, 100, 20) });
  act(() => {
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
  expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(true);
});
