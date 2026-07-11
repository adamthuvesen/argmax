import { afterEach, describe, expect, it } from "vitest";
import {
  applyFontSizeToDocument,
  applyFontToDocument,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE_ID,
  FONT_SIZE_OPTIONS,
  FONT_SIZE_STORAGE_KEY,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  resolveCssPxVariable,
  resolveTerminalFontSize,
  readStoredFontSize,
  readStoredFont
} from "./fonts.js";

afterEach(() => {
  window.localStorage.removeItem(FONT_STORAGE_KEY);
  window.localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
  document.documentElement.removeAttribute("data-font");
  document.documentElement.removeAttribute("data-font-size");
  document.documentElement.style.removeProperty("--text-terminal");
  document.documentElement.style.removeProperty("--not-px");
});

describe("fonts", () => {
  it("defaults to Inter when nothing is stored", () => {
    expect(readStoredFont()).toBe(DEFAULT_FONT_ID);
    expect(DEFAULT_FONT_ID).toBe("inter");
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

  it("applyFontToDocument sets the data-font attribute on <html>", () => {
    applyFontToDocument("geist-mono");
    expect(document.documentElement.getAttribute("data-font")).toBe("geist-mono");
  });

  it("defaults font size to default when nothing is stored", () => {
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE_ID);
    expect(DEFAULT_FONT_SIZE_ID).toBe("default");
  });

  it("reads a previously stored font size id", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "large");
    expect(readStoredFontSize()).toBe("large");
  });

  it("falls back to default when storage holds an unknown font size id", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "gigantic");
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE_ID);
  });

  it("exposes the hidden whole-app font size options", () => {
    expect(FONT_SIZE_OPTIONS.map((option) => option.id)).toEqual(["small", "default", "large"]);
  });

  it("applyFontSizeToDocument sets the data-font-size attribute on <html>", () => {
    applyFontSizeToDocument("large");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("large");
  });

  it("resolves px CSS variables for non-CSS renderers", () => {
    document.documentElement.style.setProperty("--text-terminal", "15px");
    document.documentElement.style.setProperty("--not-px", "1rem");

    expect(resolveTerminalFontSize()).toBe(15);
    expect(resolveCssPxVariable("--not-px", 13)).toBe(13);
    expect(resolveCssPxVariable("--missing-token", 12)).toBe(12);
  });
});
