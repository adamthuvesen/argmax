import TurndownService from "turndown";

/**
 * Rebuilds markdown from a clipboard's HTML flavor. Its own module because
 * Turndown is ~25 KB that only a structured paste ever needs: the composer
 * loads this lazily, so it never rides the eager chunk. Guard the load with
 * `shouldPreferHtmlFlavor` from `clipboardMarkdown.ts`, which stays static.
 */

/**
 * Shared converter. No escaping: a prompt composer sends raw text to the
 * agent, so `\_\_pycache\_\_`-style escaping would pollute paths and code the
 * user pasted. Underscore-heavy names stay verbatim.
 */
let converter: TurndownService | null = null;

function getConverter(): TurndownService {
  if (!converter) {
    converter = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      fence: "```",
      emDelimiter: "*"
    });
    converter.escape = (text) => text;
  }
  return converter;
}

export function htmlToMarkdown(html: string): string {
  return getConverter()
    .turndown(html)
    .replace(/^([ \t]*)([-*+]|\d+\.)[ \t]+/gm, "$1$2 ")
    .trimEnd();
}
