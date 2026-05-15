import { afterEach, describe, expect, it } from "vitest";
import {
  applyFontToDocument,
  DEFAULT_FONT_ID,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  getFontOption,
  readStoredFont
} from "./fonts.js";

afterEach(() => {
  window.localStorage.removeItem(FONT_STORAGE_KEY);
  document.documentElement.removeAttribute("data-font");
});

describe("fonts", () => {
  it("defaults to Lilex when nothing is stored", () => {
    expect(readStoredFont()).toBe(DEFAULT_FONT_ID);
    expect(DEFAULT_FONT_ID).toBe("lilex");
  });

  it("reads a previously stored font id", () => {
    window.localStorage.setItem(FONT_STORAGE_KEY, "jetbrains-mono");
    expect(readStoredFont()).toBe("jetbrains-mono");
  });

  it("falls back to default when storage holds an unknown id", () => {
    window.localStorage.setItem(FONT_STORAGE_KEY, "comic-sans");
    expect(readStoredFont()).toBe(DEFAULT_FONT_ID);
  });

  it("exposes a curated set of options with stacks ending in a system fallback", () => {
    expect(FONT_OPTIONS.length).toBeGreaterThanOrEqual(4);
    for (const option of FONT_OPTIONS) {
      expect(option.stack).toMatch(/(monospace|sans-serif)$/);
      expect(option.label).toBeTruthy();
    }
  });

  it("getFontOption returns the matching entry", () => {
    expect(getFontOption("fira-code").label).toBe("Fira Code");
  });

  it("applyFontToDocument sets the data-font attribute on <html>", () => {
    applyFontToDocument("geist-mono");
    expect(document.documentElement.getAttribute("data-font")).toBe("geist-mono");
  });
});
