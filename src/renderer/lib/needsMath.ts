/**
 * Whether markdown text may contain math for KaTeX to render.
 *
 * The eager chat render (`MarkdownBody` in StreamingMarkdown.tsx, plan cards)
 * skips the remark-math / rehype-katex plugins; text that may contain math
 * delegates to the lazy `MathMarkdown.tsx` chunk instead, keeping ~0.5 MB of
 * KaTeX out of the cold-start preload set.
 *
 * This mirrors `normalizeMathDelimiters`' early return (no `$` and no `\` in
 * the raw text means there is nothing math-like to normalize), so the two can
 * never disagree about what "may contain math" means. Over-matching only costs
 * a lazy chunk fetch for one message; under-matching would render math as
 * literal `$` text, so when in doubt this returns true.
 */
export function needsMath(text: string): boolean {
  return text.includes("$") || text.includes("\\");
}
