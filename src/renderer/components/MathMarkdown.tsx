import type { JSX } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "../lib/normalizeMathDelimiters.js";

/**
 * Math-enabled markdown, split out of the eager renderer graph.
 *
 * KaTeX (~535 KB JS + fonts/CSS) was in the cold-start preload set because the
 * chat surface imported `rehype-katex` eagerly — yet math delimiters are rare
 * in agent output. The eager `MarkdownBody` renders without math plugins and
 * only delegates here when the text may contain math (see `needsMath` in
 * `lib/needsMath.ts`, mirroring `normalizeMathDelimiters`' early return).
 * Automatic chunking keeps this file — and the KaTeX chunks it pulls — out
 * of the eager preload set, so first paint parses ~0.5 MB less JavaScript.
 * (Do not add a `vendor-katex` manualChunks rule for it in vite.config.ts;
 * see the comment there for why that backfires.)
 */

export function ChatMathMarkdown({
  text,
  components,
  urlTransform
}: {
  text: string;
  components?: Components;
  urlTransform?: (url: string) => string;
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      urlTransform={urlTransform}
      components={components}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
}

function escapeLeadingListMarker(text: string): string {
  return text
    .replace(/^(\s*\d{1,9})([.)])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)([-*+])(\s)/, "$1\\$2$3");
}

export function PlanInlineMath({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={{
        p: ({ children: kids }) => <>{kids}</>,
        strong: ({ children: kids }) => <strong className="plan-card-strong">{kids}</strong>,
        code: ({ className, children: kids, ...rest }) => {
          const isFenced = typeof className === "string" && className.includes("language-");
          if (isFenced) {
            return (
              <code className={className} {...rest}>
                {kids}
              </code>
            );
          }
          return <span className="plan-card-chip">{kids}</span>;
        }
      }}
    >
      {escapeLeadingListMarker(normalizeMathDelimiters(text))}
    </ReactMarkdown>
  );
}
