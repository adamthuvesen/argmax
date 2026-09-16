// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { attachSmoothWheel } from "./smoothWheel.js";

function scroller(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { value: 5000 });
  Object.defineProperty(element, "clientHeight", { value: 500 });
  element.scrollTop = 2000;
  document.body.append(element);
  return element;
}

/** Dispatches at a given event time and reports whether smoothing took it. */
function wheel(target: HTMLElement, deltaY: number, timeStamp: number, init: WheelEventInit = {}): boolean {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...init });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

let detach: (() => void) | null = null;
afterEach(() => {
  detach?.();
  document.body.replaceChildren();
});

describe("attachSmoothWheel", () => {
  // Shapes from a real mouse and trackpad logged in Safari 26 on macOS.
  it("takes over a notched mouse, slow clicks and fast spins alike", () => {
    const element = scroller();
    detach = attachSmoothWheel(element);
    expect(wheel(element, -13, 1000)).toBe(true);
    expect(wheel(element, -152, 1200)).toBe(true);
    expect(wheel(element, -303, 1215)).toBe(true);
  });

  it("leaves a trackpad native even once its swipe speeds past a mouse click", () => {
    const element = scroller();
    detach = attachSmoothWheel(element);
    const deltas = [1, 2, 2, 7, 15, 30, 45, 36, 19, 6, 2, 1];
    deltas.forEach((deltaY, index) => {
      expect(wheel(element, deltaY, 1000 + index * 6)).toBe(false);
    });
  });

  it("leaves zoom, horizontal scrolling and scroll edges to the browser", () => {
    const element = scroller();
    detach = attachSmoothWheel(element);
    expect(wheel(element, -40, 1000, { ctrlKey: true })).toBe(false);
    expect(wheel(element, -40, 2000, { shiftKey: true })).toBe(false);
    element.scrollTop = 0;
    expect(wheel(element, -40, 3000)).toBe(false);
  });
});
