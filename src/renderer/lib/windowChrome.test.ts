// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyWindowZoom } from "./windowChrome.js";

afterEach(() => {
  document.documentElement.style.removeProperty("--app-zoom");
});

describe("window zoom", () => {
  // The traffic lights keep their size in window points, so the band reserved
  // for them is CSS px divided by this factor (styles/shell-layout.css).
  it("mirrors the window's zoom onto the document", () => {
    applyWindowZoom(0.8);
    expect(document.documentElement.style.getPropertyValue("--app-zoom")).toBe("0.8");
  });

  it("ignores a factor that would collapse or invert the band", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      applyWindowZoom(bad);
      expect(document.documentElement.style.getPropertyValue("--app-zoom")).toBe("1");
    }
  });
});
