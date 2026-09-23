/** Words longer than this (URLs, hashes, minified code) reveal a character at
    a time instead of waiting to arrive whole. */
const REVEAL_LONGEST_WORD = 32;

function isWhitespace(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

/**
 * Where to cut the text for a reveal that has reached `position`: the end of
 * the word the position falls in, so words appear whole and a half-typed
 * `**bo` never flashes. While streaming, a word that has not fully arrived
 * waits for the rest of it. Never cuts a surrogate pair.
 */
export function revealBoundary(text: string, position: number, streaming: boolean): number {
  const cut = Math.floor(position);
  if (cut >= text.length) return text.length;
  if (cut <= 0) return 0;
  const limit = Math.min(text.length, cut + REVEAL_LONGEST_WORD);
  for (let index = cut; index < limit; index += 1) {
    if (isWhitespace(text.charCodeAt(index))) return index;
  }
  if (limit === text.length) {
    if (!streaming) return text.length;
    for (let index = cut - 1; index > cut - REVEAL_LONGEST_WORD && index > 0; index -= 1) {
      if (isWhitespace(text.charCodeAt(index))) return index;
    }
  }
  const code = text.charCodeAt(cut);
  return code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut;
}
