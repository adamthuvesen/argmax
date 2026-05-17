/**
 * Regression tests for audit-2026-05-17 C3.
 *
 * The audit flagged the assistant chat markdown renderer as potentially
 * vulnerable to XSS via agent-emitted `[click](javascript:alert(1))` links.
 * In react-markdown v10 the default `urlTransform` already strips any scheme
 * outside the safe-protocol allowlist (`/^(https?|ircs?|mailto|xmpp)$/i`), so
 * the audit was a false positive — BUT the protection is implicit. These
 * tests pin the behavior so a future config change (e.g. someone passes
 * `urlTransform={null}` to support a custom scheme) is caught loudly.
 *
 * If these tests fail, do not "fix" them by changing the assertions — the
 * underlying scheme-stripping has been disabled and the assistant chat is
 * now exploitable.
 */
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

afterEach(() => {
  cleanup();
});

function hrefOf(markdown: string): string | null {
  const { container } = render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>);
  return container.querySelector("a")?.getAttribute("href") ?? null;
}

describe("ReactMarkdown URL sanitization", () => {
  it("strips javascript: scheme from link hrefs", () => {
    expect(hrefOf("[click](javascript:alert(1))")).toBe("");
  });

  it("strips data: scheme from link hrefs", () => {
    expect(hrefOf("[bad](data:text/html,<script>alert(1)</script>)")).toBe("");
  });

  it("strips vbscript: scheme from link hrefs", () => {
    expect(hrefOf("[bad](vbscript:msgbox(1))")).toBe("");
  });

  it("strips file: scheme from link hrefs", () => {
    expect(hrefOf("[bad](file:///etc/passwd)")).toBe("");
  });

  it("preserves https: hrefs", () => {
    expect(hrefOf("[good](https://example.com)")).toBe("https://example.com");
  });

  it("preserves http: hrefs", () => {
    expect(hrefOf("[good](http://example.com)")).toBe("http://example.com");
  });

  it("preserves mailto: hrefs", () => {
    expect(hrefOf("[email](mailto:a@b.com)")).toBe("mailto:a@b.com");
  });

  it("preserves fragment-only hrefs", () => {
    expect(hrefOf("[top](#section)")).toBe("#section");
  });

  it("preserves relative hrefs", () => {
    expect(hrefOf("[rel](./docs/intro.md)")).toBe("./docs/intro.md");
  });
});
