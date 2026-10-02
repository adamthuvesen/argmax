// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applySidebarIntensityToDocument,
  DEFAULT_SIDEBAR_INTENSITY,
  readStoredSidebarIntensity,
  SIDEBAR_INTENSITY_STORAGE_KEY,
  toSidebarIntensity
} from "./sidebarIntensity.js";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-sidebar-intensity");
  document.documentElement.style.removeProperty("--sidebar-intensity");
});

describe("sidebar intensity", () => {
  it("accepts whole values on the dial and rejects malformed saved values", () => {
    for (const value of [0, 37, 100, "0", "70", "100"]) {
      expect(toSidebarIntensity(value)).toBe(Number(value));
    }
    for (const value of [-1, 101, 4.5, "07", " 70 ", "35oops", null, undefined]) {
      expect(toSidebarIntensity(value)).toBeNull();
    }
  });

  it("uses its own saved value and falls back to the default", () => {
    localStorage.setItem("argmax.background.level", "0");
    expect(readStoredSidebarIntensity()).toBe(DEFAULT_SIDEBAR_INTENSITY);
    localStorage.setItem(SIDEBAR_INTENSITY_STORAGE_KEY, "85");
    expect(readStoredSidebarIntensity()).toBe(85);
    localStorage.setItem(SIDEBAR_INTENSITY_STORAGE_KEY, "85oops");
    expect(readStoredSidebarIntensity()).toBe(DEFAULT_SIDEBAR_INTENSITY);
  });

  it("applies the sidebar dial to the document", () => {
    applySidebarIntensityToDocument(25);
    expect(document.documentElement.getAttribute("data-sidebar-intensity")).toBe("25");
    expect(document.documentElement.style.getPropertyValue("--sidebar-intensity")).toBe("25");
  });
});
