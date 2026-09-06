import { describe, expect, it } from "vitest";
import { scrollChildIntoNearest } from "./scrollChildIntoNearest.js";

function box(
  top: number,
  height: number,
  scrollTop = 0
): HTMLElement {
  return {
    scrollTop,
    getBoundingClientRect: () => ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({})
    })
  } as HTMLElement;
}

describe("scrollChildIntoNearest", () => {
  it("does not move a child that already sits inside the container", () => {
    const container = box(100, 300, 40);
    const child = box(180, 32);
    scrollChildIntoNearest(container, child);
    expect(container.scrollTop).toBe(40);
  });

  it("scrolls down only as far as the child's bottom edge", () => {
    const container = box(100, 300, 0);
    const child = box(420, 32);
    scrollChildIntoNearest(container, child);
    expect(container.scrollTop).toBe(52);
  });

  it("scrolls up only as far as the child's top edge", () => {
    const container = box(100, 300, 80);
    const child = box(60, 32);
    scrollChildIntoNearest(container, child);
    expect(container.scrollTop).toBe(40);
  });

  it("is a no-op when layout has not been measured", () => {
    const container = box(0, 0, 12);
    const child = box(0, 0);
    scrollChildIntoNearest(container, child);
    expect(container.scrollTop).toBe(12);
  });
});
