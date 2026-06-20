import { afterEach, describe, expect, it } from "vitest";
import {
  ACCENT_STORAGE_KEY,
  applyAccentToDocument,
  DEFAULT_ACCENT_ID,
  readStoredAccent,
  writeStoredAccent
} from "./accent.js";

afterEach(() => {
  window.localStorage.removeItem(ACCENT_STORAGE_KEY);
  document.documentElement.removeAttribute("data-accent");
});

describe("accent", () => {
  it("defaults to green when nothing is stored", () => {
    expect(readStoredAccent()).toBe(DEFAULT_ACCENT_ID);
    expect(DEFAULT_ACCENT_ID).toBe("green");
  });

  it("falls back to green when storage holds an unknown id", () => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "hot-pink");
    expect(readStoredAccent()).toBe(DEFAULT_ACCENT_ID);
  });

  it("round-trips valid accent ids through localStorage", () => {
    writeStoredAccent("orange");
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("orange");
    expect(readStoredAccent()).toBe("orange");
  });

  it("applyAccentToDocument sets the data-accent attribute on <html>", () => {
    applyAccentToDocument("blue");
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue");
  });
});
