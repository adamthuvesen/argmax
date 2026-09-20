import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vitest";
import {
  expireFreshRuns,
  FRESH_RUN_FADE_MS,
  rehypeFreshRuns,
  trackFreshRuns,
  type FreshRun
} from "./streamFreshRuns.js";

function render(markdown: string, runs: readonly FreshRun[]): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeFreshRuns(runs));
  return toHtml(processor.runSync(processor.parse(markdown)));
}

const AT = 1_000;

describe("fresh runs", () => {
  it("wraps only what the last ticks revealed", () => {
    const markdown = "one two three";
    const html = render(markdown, [{ start: 8, end: 13, at: AT }]);
    expect(html).toBe(`<p>one two <span class="stream-fresh" data-at="1000">three</span></p>`);
  });

  it("gives each tick its own span so they fade at their own phases", () => {
    const html = render("abcdef", [
      { start: 2, end: 4, at: AT },
      { start: 4, end: 6, at: AT + 64 }
    ]);
    expect(html).toBe(
      `<p>ab<span class="stream-fresh" data-at="1000">cd</span>` +
        `<span class="stream-fresh" data-at="1064">ef</span></p>`
    );
  });

  it("follows the run across an inline element boundary", () => {
    const html = render("say **loud** now", [{ start: 4, end: 16, at: AT }]);
    expect(html).toBe(
      `<p>say <strong><span class="stream-fresh" data-at="1000">loud</span></strong>` +
        `<span class="stream-fresh" data-at="1000"> now</span></p>`
    );
  });

  it("leaves code alone: it has its own reveal", () => {
    const html = render("```\nrm -rf /\n```", [{ start: 0, end: 16, at: AT }]);
    expect(html).toContain("<code>rm -rf /\n</code>");
    expect(html).not.toContain("stream-fresh");
  });

  it("marks a list item's new words like any other prose", () => {
    const html = render("- first\n- second", [{ start: 12, end: 16, at: AT }]);
    expect(html).toContain(`<li>se<span class="stream-fresh" data-at="1000">cond</span></li>`);
  });

  it("tracks one run per tick and forgets them once they have faded", () => {
    const first = trackFreshRuns([], null, 10, AT);
    expect(first).toEqual([]);

    const second = trackFreshRuns(first, 10, 20, AT + 64);
    expect(second).toEqual([{ start: 10, end: 20, at: AT + 64 }]);

    const third = trackFreshRuns(second, 20, 30, AT + 128);
    expect(third).toHaveLength(2);
    // An unchanged reveal keeps the array identity, so the body skips a re-parse.
    expect(trackFreshRuns(third, 30, 30, AT + 192)).toBe(third);

    expect(expireFreshRuns(third, AT + FRESH_RUN_FADE_MS + 200)).toEqual([]);
  });

  it("does not fade a block that was replaced or restored", () => {
    const runs = trackFreshRuns([{ start: 0, end: 40, at: AT }], 40, 10, AT + 64);
    expect(runs).toEqual([]);
  });
});
