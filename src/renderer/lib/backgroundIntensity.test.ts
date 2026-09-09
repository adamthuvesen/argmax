// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyBackgroundIntensityToDocument,
  BACKGROUND_INTENSITY_STORAGE_KEY,
  DEFAULT_BACKGROUND_INTENSITY,
  readStoredBackgroundIntensity,
  toBackgroundIntensity
} from "./backgroundIntensity.js";

afterEach(() => {
  window.localStorage.removeItem(BACKGROUND_INTENSITY_STORAGE_KEY);
  document.documentElement.removeAttribute("data-background-intensity");
});

describe("backgroundIntensity", () => {
  it("accepts only whole levels from 1 through 10", () => {
    expect(toBackgroundIntensity(1)).toBe(1);
    expect(toBackgroundIntensity("10")).toBe(10);
    expect(toBackgroundIntensity("7x")).toBeNull();
    expect(toBackgroundIntensity("7.0")).toBeNull();
    expect(toBackgroundIntensity(" 7 ")).toBeNull();
    expect(toBackgroundIntensity(4.5)).toBeNull();
    expect(toBackgroundIntensity(0)).toBeNull();
    expect(toBackgroundIntensity(11)).toBeNull();
  });

  it("reads a stored level and falls back to the shipped background", () => {
    expect(readStoredBackgroundIntensity()).toBe(DEFAULT_BACKGROUND_INTENSITY);
    window.localStorage.setItem(BACKGROUND_INTENSITY_STORAGE_KEY, "3");
    expect(readStoredBackgroundIntensity()).toBe(3);
    window.localStorage.setItem(BACKGROUND_INTENSITY_STORAGE_KEY, "3oops");
    expect(readStoredBackgroundIntensity()).toBe(DEFAULT_BACKGROUND_INTENSITY);
  });

  it("applies the level to the document root", () => {
    applyBackgroundIntensityToDocument(9);
    expect(document.documentElement.getAttribute("data-background-intensity")).toBe("9");
  });
});
