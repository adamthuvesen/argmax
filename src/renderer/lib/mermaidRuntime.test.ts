import { describe, expect, it } from "vitest";
import { isMermaidFenceClass } from "./mermaidFence.js";
import { cssColorToHex, mermaidErrorMessage } from "./mermaidRuntime.js";

describe("isMermaidFenceClass", () => {
  it("recognises mermaid and mmd fences", () => {
    expect(isMermaidFenceClass("language-mermaid")).toBe(true);
    expect(isMermaidFenceClass("language-mmd")).toBe(true);
    expect(isMermaidFenceClass("language-MERMAID")).toBe(true);
  });

  it("leaves every other fence to the highlighter", () => {
    expect(isMermaidFenceClass("language-ts")).toBe(false);
    expect(isMermaidFenceClass("language-text")).toBe(false);
    expect(isMermaidFenceClass(undefined)).toBe(false);
    expect(isMermaidFenceClass("")).toBe(false);
  });
});

describe("cssColorToHex", () => {
  it("passes hex through and expands short hex", () => {
    expect(cssColorToHex("#f1efe9")).toBe("#f1efe9");
    expect(cssColorToHex("#ABC")).toBe("#aabbcc");
  });

  it("converts comma and space rgb() to hex", () => {
    expect(cssColorToHex("rgb(241, 239, 233)")).toBe("#f1efe9");
    expect(cssColorToHex("rgb(241 239 233)")).toBe("#f1efe9");
    expect(cssColorToHex("rgba(255, 0, 0, 0.4)")).toBe("#ff0000");
  });

  it("rejects colors mermaid cannot consume", () => {
    expect(cssColorToHex("red")).toBeNull();
    expect(cssColorToHex("color-mix(in oklab, red 50%, blue)")).toBeNull();
    expect(cssColorToHex("")).toBeNull();
  });
});

describe("mermaidErrorMessage", () => {
  it("keeps the first line and strips an Error prefix", () => {
    expect(mermaidErrorMessage(new Error("Parse error on line 2:\n  extra"))).toBe(
      "Parse error on line 2:"
    );
  });
});
