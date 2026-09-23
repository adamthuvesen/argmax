import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks, type MarkdownBlockSplit } from "./markdownBlocks.js";

const texts = (split: MarkdownBlockSplit): string[] => split.blocks.map((block) => block.text);

describe("splitMarkdownBlocks", () => {
  it("tiles the source into top-level blocks, blank lines kept with the block before", () => {
    const source = "# Title\n\nFirst paragraph.\n\n```ts\nconst a = 1;\n```\n\n- one\n- two";
    const split = splitMarkdownBlocks(source);
    expect(texts(split)).toEqual(["# Title\n\n", "First paragraph.\n\n", "```ts\nconst a = 1;\n```\n\n", "- one\n- two"]);
    expect(split.blocks.map((block) => block.start)).toEqual([0, 9, 27, 51]);
  });

  it("keeps the block before the open one open, since the next can still join it", () => {
    // Streamed so far: a list, then a lone "5" that becomes "5. item".
    let split = splitMarkdownBlocks("3. three\n4. four\n\n5");
    split = splitMarkdownBlocks("3. three\n4. four\n\n5. five", split);
    expect(texts(split)).toEqual(["3. three\n4. four\n\n5. five"]);
  });

  it("splits incrementally exactly as it splits from scratch", () => {
    const source = "Intro.\n\n1. a\n\n2. b\n\nText after.\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nEnd.";
    let split: MarkdownBlockSplit | null = null;
    for (let end = 1; end <= source.length; end += 1) split = splitMarkdownBlocks(source.slice(0, end), split);
    expect(texts(split!)).toEqual(texts(splitMarkdownBlocks(source)));
  });

  it("keeps a document with link definitions whole", () => {
    const source = "Read [the docs][docs].\n\nMore.\n\n[docs]: https://example.com";
    expect(texts(splitMarkdownBlocks(source))).toEqual([source]);
  });
});
