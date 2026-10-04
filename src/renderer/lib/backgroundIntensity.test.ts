
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_INTENSITY_STORAGE_KEY,
  DEFAULT_BACKGROUND_INTENSITY,
  readStoredBackgroundIntensity,
  toBackgroundIntensity
} from "./backgroundIntensity.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("backgroundIntensity", () => {
  it("accepts only whole numbers from 0 through 100", () => {
    expect(toBackgroundIntensity(0)).toBe(0);
    expect(toBackgroundIntensity("100")).toBe(100);
    expect(toBackgroundIntensity("37")).toBe(37);
    expect(toBackgroundIntensity("7x")).toBeNull();
    expect(toBackgroundIntensity("07")).toBeNull();
    expect(toBackgroundIntensity(" 7 ")).toBeNull();
    expect(toBackgroundIntensity(4.5)).toBeNull();
    expect(toBackgroundIntensity(-1)).toBeNull();
    expect(toBackgroundIntensity(101)).toBeNull();
  });

  it("reads a stored value and falls back to the shipped background", () => {
    expect(readStoredBackgroundIntensity()).toBe(DEFAULT_BACKGROUND_INTENSITY);
    window.localStorage.setItem(BACKGROUND_INTENSITY_STORAGE_KEY, "35");
    expect(readStoredBackgroundIntensity()).toBe(35);
    window.localStorage.setItem(BACKGROUND_INTENSITY_STORAGE_KEY, "35oops");
    expect(readStoredBackgroundIntensity()).toBe(DEFAULT_BACKGROUND_INTENSITY);
  });

  it("carries a stored 1–10 level over as level × 10", () => {
    window.localStorage.setItem("argmax.background.intensity", "7");
    expect(readStoredBackgroundIntensity()).toBe(DEFAULT_BACKGROUND_INTENSITY);
    window.localStorage.setItem("argmax.background.intensity", "10");
    expect(readStoredBackgroundIntensity()).toBe(100);
    window.localStorage.setItem(BACKGROUND_INTENSITY_STORAGE_KEY, "12");
    expect(readStoredBackgroundIntensity()).toBe(12);
  });
});
