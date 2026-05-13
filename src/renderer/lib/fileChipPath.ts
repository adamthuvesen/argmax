/**
 * Conservative file-path detector for the inline-markdown FileChip.
 * Matches:
 *   - one or more path segments (alphanum / _ / - / . / @)
 *   - a final segment with a 1–5 char extension
 *   - optional `:NNN` line suffix
 * Returns null on anything containing whitespace or anything obviously not
 * a file path. We'd rather under-chip than convert random inline code into
 * clickable chips that go nowhere.
 */
const FILE_PATH_PATTERN = /^([\w./@-]+\.[a-z0-9]{1,5})(?::(\d{1,7}))?$/i;

export interface FileChipMatch {
  path: string;
  line: number | null;
}

export function matchFileChip(value: string): FileChipMatch | null {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return null;
  if (trimmed.includes(" ")) return null;
  const result = FILE_PATH_PATTERN.exec(trimmed);
  if (!result) return null;
  const path = result[1];
  if (!path || !path.includes(".")) return null;
  const lineStr = result[2];
  const line = lineStr ? Number.parseInt(lineStr, 10) : null;
  return { path, line: Number.isFinite(line) ? line : null };
}
