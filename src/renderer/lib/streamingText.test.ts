import { describe, expect, it } from "vitest";
import { healStreamingTail } from "./markdownBlocks.js";
import { revealBoundary } from "./streamingText.js";

describe("revealBoundary", () => {
  it("finishes the word the reveal position falls in", () => {
    expect(revealBoundary("alpha beta gamma", 7, true)).toBe(10);
    expect(revealBoundary("alpha beta gamma", 0, true)).toBe(0);
  });

  it("holds back a word that has not fully arrived while streaming", () => {
    expect(revealBoundary("alpha beta gam", 12, true)).toBe(10);
    expect(revealBoundary("alpha beta gam", 12, false)).toBe(14);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(40);
    for (let position = 1; position < text.length; position += 1) {
      expect(revealBoundary(text, position, true) % 2).toBe(0);
    }
  });
});

describe("healStreamingTail", () => {
  it("closes inline syntax the line being written leaves open", () => {
    expect(healStreamingTail("Some **bold")).toBe("Some **bold**");
    expect(healStreamingTail("Run `npm te")).toBe("Run `npm te`");
    expect(healStreamingTail("See [the docs](https://exa")).toBe("See the docs");
  });

  it("leaves finished lines, code, and tables alone", () => {
    expect(healStreamingTail("Some **bold\n")).toBe("Some **bold\n");
    expect(healStreamingTail("```ts\nconst a = `x")).toBe("```ts\nconst a = `x");
    expect(healStreamingTail("| a | **b")).toBe("| a | **b");
  });
});
