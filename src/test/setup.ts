import "@testing-library/jest-dom/vitest";
import "./codemirrorMock.js";

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(): null {
      return null;
    }
  });
}
