/**
 * A selection copy of rendered content carries two clipboard flavors: a lossy
 * plain-text one (list markers, backticks, and emphasis are styling, so they
 * never make it into the text) and a structured HTML one. This module decides
 * which flavor to trust; `htmlToMarkdown.ts` does the rebuilding, and stays a
 * separate module so its Turndown dependency loads only on a paste that needs
 * it.
 */

/** Tags whose presence means the HTML flavor carries structure worth keeping. */
const STRUCTURAL_TAG = /<(ul|ol|li|table|thead|tbody|tr|pre|code|h[1-6]|blockquote|strong|b|em|i|a|img)\b/i;

export function shouldPreferHtmlFlavor(html: string): boolean {
  return STRUCTURAL_TAG.test(html);
}
