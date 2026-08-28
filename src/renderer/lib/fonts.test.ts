import { afterEach, describe, expect, it } from "vitest";
import {
  applyFontSizeToDocument,
  applyFontToDocument,
  CHAT_FONT_SIZE_STORAGE_KEY,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_HINTS,
  FONT_SIZE_STORAGE_KEY,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  resolveCssPxVariable,
  resolveTerminalFontSize,
  readStoredChatFontSize,
  readStoredFontSize,
  readStoredFont
} from "./fonts.js";

afterEach(() => {
  window.localStorage.removeItem(FONT_STORAGE_KEY);
  window.localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
  window.localStorage.removeItem(CHAT_FONT_SIZE_STORAGE_KEY);
  document.documentElement.removeAttribute("data-font");
  document.documentElement.removeAttribute("data-font-size");
  document.documentElement.style.removeProperty("--text-terminal");
  document.documentElement.style.removeProperty("--not-px");
});

describe("fonts", () => {
  it("defaults to Geist Sans when nothing is stored", () => {
    expect(readStoredFont()).toBe(DEFAULT_FONT_ID);
    expect(DEFAULT_FONT_ID).toBe("geist-sans");
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

  it("defaults font size to level 3 when nothing is stored", () => {
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(DEFAULT_FONT_SIZE).toBe(3);
  });

  it("reads a previously stored level", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "5");
    expect(readStoredFontSize()).toBe(5);
  });

  it("migrates the sizes the old three-way setting stored", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "small");
    expect(readStoredFontSize()).toBe(2);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "default");
    expect(readStoredFontSize()).toBe(3);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "large");
    expect(readStoredFontSize()).toBe(4);
  });

  it("falls back to the default for a level off the scale", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "9");
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "gigantic");
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);
  });

  it("starts the agent-window size equal to the app size", () => {
    expect(readStoredChatFontSize()).toBe(DEFAULT_FONT_SIZE);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "4");
    expect(readStoredChatFontSize()).toBe(4);
  });

  it("keeps the agent-window size independent once it is stored", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "4");
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, "1");

    expect(readStoredChatFontSize()).toBe(1);
    expect(readStoredFontSize()).toBe(4);
  });

  it("falls back to the app size when the stored agent-window size is unknown", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "2");
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, "gigantic");

    expect(readStoredChatFontSize()).toBe(2);
  });

  it("captions every level of the scale", () => {
    expect(Object.keys(FONT_SIZE_HINTS)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("applyFontSizeToDocument sets the data-font-size attribute on <html>", () => {
    applyFontSizeToDocument(4);
    expect(document.documentElement.getAttribute("data-font-size")).toBe("4");
  });

  it("resolves px CSS variables for non-CSS renderers", () => {
    document.documentElement.style.setProperty("--text-terminal", "15px");
    document.documentElement.style.setProperty("--not-px", "1rem");

    expect(resolveTerminalFontSize()).toBe(15);
    expect(resolveCssPxVariable("--not-px", 13)).toBe(13);
    expect(resolveCssPxVariable("--missing-token", 12)).toBe(12);
  });
});
