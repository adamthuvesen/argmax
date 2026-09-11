import { describe, expect, it } from "vitest";
import { codePointLength, sliceCodePointPrefix } from "./streamingText.js";

describe("streaming text prefixes", () => {
  it("counts valid surrogate pairs as one code point", () => {
    expect(codePointLength("A😀🧠e\u0301")).toBe(5);
    expect(codePointLength("\ud83dA")).toBe(2);
  });

  it("never splits a surrogate pair at a reveal boundary", () => {
    const text = "A😀🧠e\u0301";

    expect(sliceCodePointPrefix(text, 1).text).toBe("A");
    expect(sliceCodePointPrefix(text, 2).text).toBe("A😀");
    expect(sliceCodePointPrefix(text, 3).text).toBe("A😀🧠");
  });

  it("advances an existing cursor without changing the visible prefix", () => {
    const text = "😀".repeat(100);
    const first = sliceCodePointPrefix(text, 5);
    const next = sliceCodePointPrefix(text, 9, first.cursor);

    expect(first).toMatchObject({ text: "😀".repeat(5) });
    expect(first.cursor.utf16Offset).toBe(10);
    expect(next).toMatchObject({ text: "😀".repeat(9) });
    expect(next.cursor.utf16Offset).toBe(18);
  });
});
