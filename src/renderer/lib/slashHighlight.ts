export type SkillHighlightSegment = { text: string; skill: boolean };

/**
 * Split text into plain/skill segments for marking the tokens. Every `/name`
 * token that starts the input or follows whitespace — and that `isSkill`
 * confirms — becomes a `skill: true` segment; everything else stays plain.
 * Returns null when no confirmed token exists so the composer overlay can stay
 * unmounted for ordinary typing. Segment text concatenates back to the exact
 * input: the overlay mirrors a textarea, so not one character may differ.
 *
 * The composer confirms names against the skills it loaded. The transcript has
 * no such list and passes an accept-all predicate, leaning on the token shape
 * alone — which is why the shape must keep rejecting paths.
 */
export function splitSkillTokens(
  input: string,
  isSkill: (lowercaseName: string) => boolean
): SkillHighlightSegment[] | null {
  const pattern = /(^|\s)\/([\w-]+(?::[\w-]+)?)(?=\s|$)/g;
  const segments: SkillHighlightSegment[] = [];
  let cursor = 0;
  let found = false;
  for (const match of input.matchAll(pattern)) {
    const name = match[2] ?? "";
    if (!isSkill(name.toLowerCase())) continue;
    const tokenStart = match.index + (match[1]?.length ?? 0);
    if (tokenStart > cursor) segments.push({ text: input.slice(cursor, tokenStart), skill: false });
    segments.push({ text: `/${name}`, skill: true });
    cursor = tokenStart + name.length + 1;
    found = true;
  }
  if (!found) return null;
  if (cursor < input.length) segments.push({ text: input.slice(cursor), skill: false });
  return segments;
}
