// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRAST_STORAGE_KEY,
  DEFAULT_CONTRAST,
  readStoredContrast,
  toContrast
} from "./contrast.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("contrast", () => {
  it("accepts only whole numbers from 0 through 100", () => {
    expect(toContrast(0)).toBe(0);
    expect(toContrast("100")).toBe(100);
    expect(toContrast("37")).toBe(37);
    expect(toContrast("07")).toBeNull();
    expect(toContrast(4.5)).toBeNull();
    expect(toContrast(-1)).toBeNull();
    expect(toContrast(101)).toBeNull();
  });

  it("reads a stored value and falls back to the shipped lines", () => {
    expect(readStoredContrast()).toBe(DEFAULT_CONTRAST);
    window.localStorage.setItem(CONTRAST_STORAGE_KEY, "80");
    expect(readStoredContrast()).toBe(80);
    window.localStorage.setItem(CONTRAST_STORAGE_KEY, "80oops");
    expect(readStoredContrast()).toBe(DEFAULT_CONTRAST);
  });
});
