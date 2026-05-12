import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./typingTarget.js";

describe("isTypingTarget", () => {
  it("returns false for null", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it("returns true for inputs and textareas", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
  });

  it("returns true for contenteditable elements", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isTypingTarget(div)).toBe(true);
  });

  it("returns true for role textbox / combobox / searchbox", () => {
    const a = document.createElement("div");
    a.setAttribute("role", "textbox");
    const b = document.createElement("div");
    b.setAttribute("role", "combobox");
    const c = document.createElement("div");
    c.setAttribute("role", "searchbox");
    expect(isTypingTarget(a)).toBe(true);
    expect(isTypingTarget(b)).toBe(true);
    expect(isTypingTarget(c)).toBe(true);
  });

  it("returns false for plain buttons and divs", () => {
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});
