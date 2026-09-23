import { Lexer } from "marked";
import remend, { type RemendOptions } from "remend";

// Loaded lazily by StreamingMarkdown, only once an answer is streaming: the
// lexer and the healer are chat-live tools that stay out of the cold-start
// bundle.

/**
 * A top-level Markdown block of a streaming answer: a paragraph, a list, a
 * fenced code block. `start` is its offset in the source, which never moves
 * once the block is followed by another one, so it doubles as a React key.
 */
export type MarkdownBlock = { start: number; text: string };

/** What the previous split learned: every block before `stableEnd` is final. */
export type MarkdownBlockSplit = {
  source: string;
  stableEnd: number;
  blocks: readonly MarkdownBlock[];
};

// A reference-style link or footnote resolves against a definition anywhere in
// the document, so a block rendered on its own could lose it.
const DEFINITION_LINE = /^ {0,3}\[\^?[^\]\n]+\]:/m;

/**
 * Splits streaming Markdown into top-level blocks so a renderer only has to
 * re-parse the block still being written. Text arriving later can change the
 * block being written and, by joining it, the one before; nothing earlier.
 * Those two stay open and everything before them is final.
 *
 * Incremental: when `source` extends `previous.source`, only the open blocks
 * are lexed again, so a frame's cost is theirs, not the whole answer's.
 */
export function splitMarkdownBlocks(
  source: string,
  previous?: MarkdownBlockSplit | null
): MarkdownBlockSplit {
  if (DEFINITION_LINE.test(source)) {
    return { source, stableEnd: 0, blocks: source ? [{ start: 0, text: source }] : [] };
  }
  let stableEnd = 0;
  let stable: MarkdownBlock[] = [];
  if (
    previous &&
    previous.stableEnd > 0 &&
    source.length >= previous.stableEnd &&
    source.startsWith(previous.source.slice(0, previous.stableEnd))
  ) {
    stableEnd = previous.stableEnd;
    stable = previous.blocks.filter((block) => block.start < stableEnd);
  }

  const tail = source.slice(stableEnd);
  const raws: string[] = [];
  for (const token of Lexer.lex(tail, { gfm: true })) {
    // Blank lines belong to the block before them, so a block's text is
    // exactly the source between two block starts.
    if (token.type === "space" && raws.length > 0) raws[raws.length - 1] += token.raw;
    else raws.push(token.raw);
  }
  // marked's `raw` fields tile its input. If they ever stop doing so, keep the
  // tail as one block rather than render text at the wrong offsets.
  if (raws.join("") !== tail) {
    return {
      source,
      stableEnd,
      blocks: tail ? [...stable, { start: stableEnd, text: tail }] : stable
    };
  }

  const blocks = stable.slice();
  let offset = stableEnd;
  for (const [index, raw] of raws.entries()) {
    // The last two blocks stay open: a block can still join the one before
    // it (a lone `5` becomes `5. item`, continuing the list above it).
    if (index === raws.length - 2) stableEnd = offset;
    blocks.push({ start: offset, text: raw });
    offset += raw.length;
  }
  return { source, stableEnd, blocks };
}

/** The unfinished syntax a half-arrived tail can end in. Only what the stream
    will close anyway, so the live render never differs from the final one. */
const TAIL_HEALING: RemendOptions = {
  bold: true,
  boldItalic: true,
  italic: true,
  inlineCode: true,
  strikethrough: true,
  links: true,
  linkMode: "text-only",
  images: true,
  setextHeadings: true,
  comparisonOperators: false,
  htmlTags: false,
  inlineKatex: false,
  katex: false,
  singleTilde: false
};

/**
 * Closes the syntax the line being written leaves open, so `**bo` shows as
 * bold rather than as asterisks until the rest arrives. Only that last line,
 * and never inside code or a table: those are where a marker counted across
 * the whole block is not actually open.
 */
export function healStreamingTail(text: string): string {
  if (text.endsWith("\n") || /^ {0,3}(?:```|~~~)|^ {4}|^\t/.test(text)) return text;
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if (line.trimStart().startsWith("|")) return text;
  const healed = remend(line, TAIL_HEALING);
  return healed === line ? text : text.slice(0, lineStart) + healed;
}

