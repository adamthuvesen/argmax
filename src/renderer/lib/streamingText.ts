export type CodePointSliceCursor = {
  text: string;
  codePointCount: number;
  utf16Offset: number;
};

function nextCodePointOffset(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  if (code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length) {
    const trailing = text.charCodeAt(offset + 1);
    if (trailing >= 0xdc00 && trailing <= 0xdfff) return offset + 2;
  }
  return offset + 1;
}

/** Counts Unicode code points without allocating an array of characters. */
export function codePointLength(text: string): number {
  let length = 0;
  for (let offset = 0; offset < text.length; length += 1) {
    offset = nextCodePointOffset(text, offset);
  }
  return length;
}

/**
 * Returns a code-point-safe prefix. When the same text advances, `previous`
 * lets the next call scan only the newly revealed characters.
 */
export function sliceCodePointPrefix(
  text: string,
  codePointCount: number,
  previous?: CodePointSliceCursor | null
): { text: string; cursor: CodePointSliceCursor } {
  let visible = 0;
  let offset = 0;
  if (
    previous?.text === text &&
    previous.codePointCount <= codePointCount &&
    previous.utf16Offset <= text.length
  ) {
    visible = previous.codePointCount;
    offset = previous.utf16Offset;
  }

  while (offset < text.length && visible < codePointCount) {
    offset = nextCodePointOffset(text, offset);
    visible += 1;
  }

  return {
    text: text.slice(0, offset),
    cursor: { text, codePointCount: visible, utf16Offset: offset }
  };
}
