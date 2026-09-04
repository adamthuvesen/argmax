import { describe, expect, it } from "vitest";
import { needsMath } from "./needsMath.js";
import { normalizeMathDelimiters } from "./normalizeMathDelimiters.js";

describe("needsMath", () => {
  it("returns false for prose without math markers", () => {
    expect(needsMath("Hello world, no math here.")).toBe(false);
    expect(needsMath("```bash\nPRICE=50\necho hi\n```")).toBe(false);
  });

  it("returns true for anything normalizeMathDelimiters would transform", () => {
    for (const text of [
      "The cost is $50 total.",
      "$$E = mc^2$$",
      "\\[ x^2 \\]",
      "\\(\\tau\\) is the threshold",
      "plain backslash \\ path"
    ]) {
      expect(needsMath(text)).toBe(true);
    }
  });

  it("never under-matches normalizeMathDelimiters' early return", () => {
    // needsMath must mirror the early return: whenever normalization would
    // change the text, needsMath must be true, or math renders as literal
    // `$` text on the eager path. Over-matching (currency) is fine — it only
    // costs a lazy chunk fetch.
    const samples = [
      "Prices are $10 for standard and $20 for pro tier.",
      "```bash\nPRICE=$50\necho \"\\[ preserved \\]\"\n```",
      "C:\\Users\\name\\repo",
      "plain text",
      "$x + y = z$ and \\(\\tau\\)"
    ];
    for (const text of samples) {
      if (normalizeMathDelimiters(text) !== text) {
        expect(needsMath(text)).toBe(true);
      }
    }
  });
});
