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
// Requires at least one non-dot character before the extension so inputs like
// `.ts` aren't matched as path=".ts".
const FILE_PATH_PATTERN = /^([\w/@-][\w./@-]*\.[a-z0-9]{1,5})(?::(\d{1,7}))?$/i;

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

/**
 * Compact display label for a FileChip — always the basename + optional :line.
 * Full path stays available via aria-label, title tooltip, and the hover preview
 * popover, so directory context is one hover away.
 */
export function formatFileChipLabel(
  path: string,
  _workspaceCwd: string | null | undefined,
  line: number | null
): string {
  const base = basename(path);
  return line ? `${base}:${line}` : base;
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
