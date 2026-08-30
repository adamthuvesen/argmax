import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown.js";

describe("htmlToMarkdown", () => {
  it("rebuilds the shapes a chat copy loses in the plain flavor", () => {
    const html =
      "<ol><li><code>config.toml</code> is untracked while <code>validate.py:524</code> requires it</li>" +
      "<li><strong>bold</strong> and <em>italic</em> text</li></ol>";
    expect(htmlToMarkdown(html)).toBe(
      "1. `config.toml` is untracked while `validate.py:524` requires it\n2. **bold** and *italic* text"
    );
  });

  it("keeps underscore-heavy names verbatim instead of escaping them", () => {
    // The prompt goes to the agent as raw text, so \_\_pycache\_\_-style
    // escaping would pollute pasted paths and code.
    expect(htmlToMarkdown("<code>agents/hooks/__pycache__/</code>")).toBe("`agents/hooks/__pycache__/`");
    expect(htmlToMarkdown("<p>see agents/hooks/__pycache__/ here</p>")).toBe(
      "see agents/hooks/__pycache__/ here"
    );
  });

  it("fences copied code blocks", () => {
    expect(htmlToMarkdown("<pre><code>let x = 1;\nlet y = 2;</code></pre>")).toBe(
      "```\nlet x = 1;\nlet y = 2;\n```"
    );
  });

  it("keeps links as markdown", () => {
    expect(htmlToMarkdown('<p>read the <a href="https://example.com">docs</a></p>')).toBe(
      "read the [docs](https://example.com)"
    );
  });

  it("nests lists", () => {
    expect(htmlToMarkdown("<ul><li>top<ul><li>inner</li></ul></li></ul>")).toBe(
      "- top\n    - inner"
    );
  });
});
