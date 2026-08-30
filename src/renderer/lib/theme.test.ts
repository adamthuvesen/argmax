// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme
} from "./theme.js";

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
});

describe("theme", () => {
  it("defaults to dark when nothing is stored", () => {
    expect(DEFAULT_THEME_MODE).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("reads a previously stored mode", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(readStoredTheme()).toBe("system");
  });

  it("falls back to dark when storage holds an unknown id", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    expect(readStoredTheme()).toBe("dark");
  });

  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
