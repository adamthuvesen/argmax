import { afterEach, describe, expect, it } from "vitest";
import {
  applyFontSizeToDocument,
  applyFontToDocument,
  CHAT_FONT_SIZE_STORAGE_KEY,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STORAGE_KEY,
  fontSizeBasePx,
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
  window.localStorage.removeItem("argmax.font.size");
  window.localStorage.removeItem("argmax.font.size.chat");
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

  it("defaults font size to level 6 when nothing is stored", () => {
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(DEFAULT_FONT_SIZE).toBe(6);
  });

  it("reads a previously stored level", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "10");
    expect(readStoredFontSize()).toBe(10);
  });

  it("migrates levels stored by the retired 1–5 scale under its own key", () => {
    window.localStorage.setItem("argmax.font.size", "1");
    expect(readStoredFontSize()).toBe(4);

    window.localStorage.setItem("argmax.font.size", "3");
    expect(readStoredFontSize()).toBe(6);

    window.localStorage.setItem("argmax.font.size", "5");
    expect(readStoredFontSize()).toBe(8);

    // A value under the new key wins over any legacy leftover.
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "2");
    expect(readStoredFontSize()).toBe(2);
  });

  it("migrates the sizes the old three-way setting stored", () => {
    window.localStorage.setItem("argmax.font.size", "small");
    expect(readStoredFontSize()).toBe(5);

    window.localStorage.setItem("argmax.font.size", "default");
    expect(readStoredFontSize()).toBe(6);

    window.localStorage.setItem("argmax.font.size", "large");
    expect(readStoredFontSize()).toBe(7);
  });

  it("falls back to the default for a level off the scale", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "14");
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "gigantic");
    expect(readStoredFontSize()).toBe(DEFAULT_FONT_SIZE);
  });

  it("starts the agent-window size equal to the app size", () => {
    expect(readStoredChatFontSize()).toBe(DEFAULT_FONT_SIZE);

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "8");
    expect(readStoredChatFontSize()).toBe(8);
  });

  it("keeps the agent-window size independent once it is stored", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "8");
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, "1");

    expect(readStoredChatFontSize()).toBe(1);
    expect(readStoredFontSize()).toBe(8);
  });

  it("migrates a legacy agent-window size under its own key", () => {
    window.localStorage.setItem("argmax.font.size.chat", "4");
    expect(readStoredChatFontSize()).toBe(7);
  });

  it("falls back to the app size when the stored agent-window size is unknown", () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, "2");
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, "gigantic");

    expect(readStoredChatFontSize()).toBe(2);
  });

  it("maps levels to body-text pixels, 8px at 1 through 17px at 10", () => {
    expect(fontSizeBasePx(1)).toBe(8);
    expect(fontSizeBasePx(DEFAULT_FONT_SIZE)).toBe(13);
    expect(fontSizeBasePx(10)).toBe(17);
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
