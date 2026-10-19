// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme
} from "./theme.js";

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
});

describe("theme", () => {
  it("defaults to system when nothing is stored", () => {
    expect(readStoredTheme()).toBe("system");
  });

  it("reads a previously stored mode", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("falls back to system when storage holds an unknown id", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    expect(readStoredTheme()).toBe("system");
  });

  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
