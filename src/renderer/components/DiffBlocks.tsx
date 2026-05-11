import type { JSX } from "react";
import type { ParsedDiffBlock } from "../lib/diff.js";

export function DiffBlocks({ blocks }: { blocks: ParsedDiffBlock[] }): JSX.Element {
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
                <code>{line.content || " "}</code>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
