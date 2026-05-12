import { useMemo, type JSX } from "react";
import type { ParsedDiffBlock } from "../lib/diff.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";

export function DiffBlocks({
  blocks,
  filePath
}: {
  blocks: ParsedDiffBlock[];
  filePath?: string | null;
}): JSX.Element {
  // Subscribing to the ready signal re-renders the component as soon as the
  // shiki bundle finishes loading, swapping in highlighted tokens without
  // blocking the initial paint.
  const ready = useHighlighterReady();
  const lang = useMemo(() => langFromPath(filePath ?? null), [filePath]);
  return (
    <div className="diff-blocks">
      {blocks.map((block) =>
        block.kind === "omitted" ? (
          <div className="diff-omitted" key={block.id}>
            {block.count} unmodified lines
          </div>
        ) : (
          <div className="diff-hunk" key={block.id}>
            <div className="diff-hunk-header">{block.header}</div>
            {block.lines.map((line, index) => (
              <div className={`diff-line ${line.kind}`} key={`${block.id}-${index}`}>
                <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
                <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
                <code>
                  <DiffLineContent content={line.content || " "} lang={ready ? lang : null} />
                </code>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function DiffLineContent({ content, lang }: { content: string; lang: string | null }): JSX.Element {
  if (!lang) {
    return <>{content}</>;
  }
  const tokens = highlightLine(content, lang);
  if (tokens.length === 1 && tokens[0] && !tokens[0].color) {
    // Shiki returned a single uncolored token — equivalent to the plain
    // fallback. Skip the span wrapper noise.
    return <>{tokens[0].content}</>;
  }
  return (
    <>
      {tokens.map((token, index) => (
        <span
          className="hl-token"
          key={index}
          style={token.color ? { color: token.color } : undefined}
        >
          {token.content}
        </span>
      ))}
    </>
  );
}
