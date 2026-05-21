import "@testing-library/jest-dom/vitest";

function emptyClientRects(): DOMRectList {
  return Object.assign([], { item: () => null });
}

function zeroRect(): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({})
  };
}

// CodeMirror asks Range for layout during editor measurement. jsdom does not
// implement those APIs, so provide zero-sized geometry and let component tests
// keep exercising the React contract instead of browser layout internals.
if (typeof Range !== "undefined") {
  if (!("getClientRects" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: emptyClientRects
    });
  }
  if (!("getBoundingClientRect" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: zeroRect
    });
  }
}
