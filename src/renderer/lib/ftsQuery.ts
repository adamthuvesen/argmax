export function buildSafeFtsPrefixQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .trim()
    .split(/[^A-Za-z0-9_]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  const phrase = `"${tokens.join(" ")}"`;
  const prefixed = tokens.map((token) => `${token}*`).join(" ");
  return `${phrase} OR (${prefixed})`;
}
