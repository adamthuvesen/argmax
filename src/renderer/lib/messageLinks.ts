/**
 * Find the URLs in a plain-text message so the transcript can render them as
 * links.
 *
 * Assistant prose goes through `remark-gfm`, which autolinks for free. A sent
 * user message is deliberately *not* markdown — it is shown as the exact text
 * that was typed — so a pasted URL had no way to become clickable. This is the
 * narrow replacement: `http(s)` runs only, no `www.`, no bare domains, no
 * `mailto:`. Guessing at a scheme in text the user did not write is how a
 * sentence ending in "menti.com." becomes a broken link.
 */

export type MessageLinkSegment = { text: string; link: boolean };

/**
 * A scheme followed by anything that is not whitespace or a quote. Deliberately
 * greedy: the trailing-punctuation trim below decides where the URL really
 * ends, because a `?` can be a query string or the end of a question.
 */
const URL_RUN = /https?:\/\/[^\s<>"'`]+/gi;

/** Scheme plus at least one host character, the minimum for a real link. */
const HAS_HOST = /^https?:\/\/[^\s/?#]/i;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const SENTENCE_TAIL = ".,;:!?";

function occurrences(text: string, character: string): number {
  let count = 0;
  for (const char of text) if (char === character) count += 1;
  return count;
}

/**
 * Give back the punctuation a sentence lent the URL. A closing bracket is kept
 * when the URL opened it — Wikipedia paths carry balanced parens — and dropped
 * when it only closed a paren from the surrounding prose.
 */
function trimSentencePunctuation(run: string): string {
  let end = run.length;
  while (end > 0) {
    const char = run[end - 1];
    const opener = CLOSERS[char];
    if (opener) {
      const head = run.slice(0, end);
      if (occurrences(head, opener) >= occurrences(head, char)) break;
      end -= 1;
      continue;
    }
    if (SENTENCE_TAIL.includes(char)) {
      end -= 1;
      continue;
    }
    break;
  }
  return run.slice(0, end);
}

/**
 * Split text into plain and link segments. Returns null when the text holds no
 * URL, so the caller can keep rendering the string it already had rather than
 * an array of one. Segment text concatenates back to the exact input: the
 * bubble shows what was sent, character for character.
 */
export function splitLinkSegments(input: string): MessageLinkSegment[] | null {
  const segments: MessageLinkSegment[] = [];
  let cursor = 0;
  for (const match of input.matchAll(URL_RUN)) {
    const url = trimSentencePunctuation(match[0]);
    if (!HAS_HOST.test(url)) continue;
    if (match.index > cursor) segments.push({ text: input.slice(cursor, match.index), link: false });
    segments.push({ text: url, link: true });
    cursor = match.index + url.length;
  }
  if (segments.length === 0) return null;
  if (cursor < input.length) segments.push({ text: input.slice(cursor), link: false });
  return segments;
}
