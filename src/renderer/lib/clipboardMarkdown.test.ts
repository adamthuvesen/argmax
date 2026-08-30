import { describe, expect, it } from "vitest";
import { shouldPreferHtmlFlavor } from "./clipboardMarkdown.js";

describe("shouldPreferHtmlFlavor", () => {
  it("wants the HTML flavor only when it carries structure", () => {
    expect(shouldPreferHtmlFlavor("<ul><li>item</li></ul>")).toBe(true);
    expect(shouldPreferHtmlFlavor("<code>path</code>")).toBe(true);
    expect(shouldPreferHtmlFlavor("<h2>Title</h2>")).toBe(true);
    expect(shouldPreferHtmlFlavor('<span style="font-weight: 390">just a line</span>')).toBe(false);
    expect(shouldPreferHtmlFlavor("")).toBe(false);
  });
});
