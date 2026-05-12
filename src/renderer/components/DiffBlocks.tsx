import { useMemo, type JSX } from "react";
import { pairDiffLines, type DiffLinePair, type ParsedDiffBlock, type ParsedDiffLine } from "../lib/diff.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";

export type DiffView = "unified" | "side-by-side";

export function DiffBlocks({
  blocks,
  filePath,
  view = "unified"
}: {
  blocks: ParsedDiffBlock[];
  filePath?: string | null;
  view?: DiffView;
}): JSX.Element {
  // Subscribing to the ready signal re-renders the component as soon as the
  // shiki bundle finishes loading, swapping in highlighted tokens without
  // blocking the initial paint.
  const ready = useHighlighterReady();
  const lang = useMemo(() => langFromPath(filePath ?? null), [filePath]);
  const effectiveLang = ready ? lang : null;
  return (
    <div className={`diff-blocks${view === "side-by-side" ? " diff-side-by-side" : ""}`}>
      {blocks.map((block) =>
        block.kind === "omitted" ? (
          <div className="diff-omitted" key={block.id}>
            {block.count} unmodified lines
          </div>
        ) : view === "side-by-side" ? (
          <SideBySideHunk key={block.id} block={block} lang={effectiveLang} />
        ) : (
          <UnifiedHunk key={block.id} block={block} lang={effectiveLang} />
        )
      )}
    </div>
  );
}

function UnifiedHunk({
  block,
  lang
}: {
  block: Extract<ParsedDiffBlock, { kind: "hunk" }>;
  lang: string | null;
}): JSX.Element {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{block.header}</div>
      {block.lines.map((line, index) => (
        <div className={`diff-line ${line.kind}`} key={`${block.id}-${index}`}>
          <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
          <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
          <code>
            <DiffLineContent content={line.content || " "} lang={lang} />
          </code>
        </div>
      ))}
    </div>
  );
}

function SideBySideHunk({
  block,
  lang
}: {
  block: Extract<ParsedDiffBlock, { kind: "hunk" }>;
  lang: string | null;
}): JSX.Element {
  const pairs = useMemo(() => pairDiffLines(block.lines), [block.lines]);
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{block.header}</div>
      <div className="diff-sbs-grid" role="presentation">
        {pairs.map((pair, index) => (
          <SideBySideRow key={`${block.id}-${index}`} pair={pair} lang={lang} />
        ))}
      </div>
    </div>
  );
}

function SideBySideRow({
  pair,
  lang
}: {
  pair: DiffLinePair;
  lang: string | null;
}): JSX.Element {
  return (
    <>
      <DiffCell line={pair.old} side="old" lang={lang} />
      <DiffCell line={pair.new} side="new" lang={lang} />
    </>
  );
}

function DiffCell({
  line,
  side,
  lang
}: {
  line: ParsedDiffLine | null;
  side: "old" | "new";
  lang: string | null;
}): JSX.Element {
  if (!line) {
    return (
      <div className={`diff-line diff-sbs-cell diff-sbs-empty diff-sbs-${side}`}>
        <span className="diff-line-number" />
        <code aria-hidden="true">{" "}</code>
      </div>
    );
  }
  const number = side === "old" ? line.oldLineNumber : line.newLineNumber;
  return (
    <div className={`diff-line diff-sbs-cell diff-sbs-${side} ${line.kind}`}>
      <span className="diff-line-number">{number ?? ""}</span>
      <code>
        <DiffLineContent content={line.content || " "} lang={lang} />
      </code>
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

