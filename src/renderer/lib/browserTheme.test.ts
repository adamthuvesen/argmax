// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_THEME_STORAGE_KEY,
  readStoredBrowserTheme,
  writeStoredBrowserTheme
} from "./browserTheme.js";

afterEach(() => {
  window.localStorage.removeItem(BROWSER_THEME_STORAGE_KEY);
});

describe("browser theme", () => {
  it("defaults to system and round-trips a stored mode", () => {
    expect(readStoredBrowserTheme()).toBe("system");

    writeStoredBrowserTheme("light");
    expect(readStoredBrowserTheme()).toBe("light");
  });

  it("rejects unknown stored values", () => {
    window.localStorage.setItem(BROWSER_THEME_STORAGE_KEY, "sepia");
    expect(readStoredBrowserTheme()).toBe("system");
  });
});
