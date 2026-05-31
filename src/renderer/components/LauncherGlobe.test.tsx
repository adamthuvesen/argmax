import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// three-globe is heavy and only matters at draw time; stub it so the unit test
// stays fast. The real three.js WebGLRenderer is left intact — with getContext
// stubbed to null below it throws, exercising the component's no-WebGL bail.
vi.mock("three-globe", () => ({ default: class {} }));

import { LauncherGlobe } from "./LauncherGlobe.js";

describe("LauncherGlobe", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const originalConsoleError = console.error;
    vi.spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
      if (typeof message === "string" && message.includes("THREE.WebGLRenderer: Error creating WebGL context")) {
        return;
      }
      originalConsoleError(message, ...args);
    });
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when disabled", () => {
    const { container } = render(<LauncherGlobe enabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an aria-hidden canvas (and a scrim) when enabled, bailing without WebGL", () => {
    const { container } = render(<LauncherGlobe enabled />);
    const canvas = container.querySelector("canvas.launcher-globe");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".launcher-globe-scrim")).not.toBeNull();
  });
});
