// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND_INTENSITY } from "./backgroundIntensity.js";
import { readActiveXtermTheme } from "./xtermTheme.js";

vi.mock("./pixelField.js", () => ({
  readColorToken: (name: string) => name === "--terminal-surface"
    ? { r: 3, g: 3, b: 3 }
    : { r: 90, g: 143, b: 114 }
}));

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-background-intensity");
  document.documentElement.removeAttribute("data-window-translucent");
});

it("resolves the terminal background token even at the default dark intensity", () => {
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.setAttribute("data-background-intensity", String(DEFAULT_BACKGROUND_INTENSITY));
  expect(readActiveXtermTheme().background).toBe("rgb(3, 3, 3)");
});
