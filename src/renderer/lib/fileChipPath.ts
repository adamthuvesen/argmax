import { collapseHome } from "./displayPath.js";

/**
 * File-path detector for the inline-markdown FileChip. Two shapes match, each
 * with an optional `:NNN` line or `:NNN:NN` line and column suffix:
 *
 *  - Relative paths and bare names: path characters only, no whitespace, and a
 *    final extension. A bare name keeps a 1–5 char extension, so prose such as
 *    `config.enabled` stays code; a value with a `/` allows up to 10 chars, for
 *    files such as `data/model.sqlite` or `out/events.parquet`.
 *  - Anchored paths, which say where they live (`/…`, `~/…`, `../…`): any
 *    characters but a newline or backtick, so `~/Library/Application Support/…`
 *    matches, and the extension is optional. An anchored path without one
 *    (`/etc/hosts`, `~/dev/repo/Makefile`) could as easily be an API route, so
 *    the match asks the caller to confirm the file exists before showing a chip.
 */
// Requires at least one non-dot character before the extension so inputs like
// `.ts` aren't matched as path=".ts".
const RELATIVE_PATTERN = /^([\w@-][\w./@-]*\.([a-z0-9]{1,10}))(?::(\d{1,7})(?::\d{1,7})?)?$/i;
const ANCHORED_PATTERN = /^((?:\/|~\/|\.\.\/)[^\n`]*?)(?::(\d{1,7})(?::\d{1,7})?)?$/;
const EXTENSION_PATTERN = /\.[a-z0-9]{1,10}$/i;
const MAX_RELATIVE_LENGTH = 200;
const MAX_ANCHORED_LENGTH = 1024;

interface FileChipMatch {
  path: string;
  line: number | null;
  /** True for an anchored path without an extension: show a chip only once
   *  the file is confirmed to exist. */
  needsExistenceCheck: boolean;
}

/** Convert a linked absolute workspace path into the relative path expected by
 * the Files view. Encoded spaces come from Markdown links wrapped in `<...>`. */
export function normalizeFileChipPath(path: string, workspaceCwd: string | null | undefined): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the original text. The file resolver will report that it is not openable.
  }
  if (!workspaceCwd) return decoded;
  const root = workspaceCwd.replace(/\/+$/, "");
  // `../sibling/file` names a file beside the workspace, so make it absolute.
  const absolute = decoded.startsWith("../") ? joinPath(root, decoded) : decoded;
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

/** Resolves `.` and `..` segments of `relative` against an absolute `root`. */
function joinPath(root: string, relative: string): string {
  const segments = root.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "..") {
      if (segments.length > 1) segments.pop();
    } else if (segment !== "." && segment !== "") {
      segments.push(segment);
    }
  }
  return segments.join("/") || "/";
}

export function matchFileChip(value: string): FileChipMatch | null {
  const trimmed = value.trim();
  if (trimmed.length < 3) return null;
  const anchored = /^(?:\/|~\/|\.\.\/)/.test(trimmed);
  if (anchored) {
    if (trimmed.length > MAX_ANCHORED_LENGTH) return null;
    const result = ANCHORED_PATTERN.exec(trimmed);
    const path = result?.[1]?.trimEnd();
    if (!result || !path || path.endsWith("/")) return null;
    return {
      path,
      line: parseLine(result[2]),
      needsExistenceCheck: !EXTENSION_PATTERN.test(basename(path))
    };
  }
  if (trimmed.length > MAX_RELATIVE_LENGTH) return null;
  const result = RELATIVE_PATTERN.exec(trimmed);
  const path = result?.[1];
  const extension = result?.[2];
  if (!result || !path || !extension) return null;
  if (!path.includes("/") && extension.length > 5) return null;
  return { path, line: parseLine(result[3]), needsExistenceCheck: false };
}

function parseLine(value: string | undefined): number | null {
  const line = value ? Number.parseInt(value, 10) : null;
  return line !== null && Number.isFinite(line) ? line : null;
}

/**
 * Display label for a FileChip. A file in the workspace shows its basename;
 * the full path stays in the aria-label, title tooltip, and hover preview. A
 * file outside the workspace shows its whole path (home collapsed to `~`),
 * because the basename alone does not say where it lives.
 */
export function formatFileChipLabel(
  path: string,
  workspaceCwd: string | null | undefined,
  line: number | null
): string {
  const root = workspaceCwd?.replace(/\/+$/, "");
  const isOutsideWorkspace =
    Boolean(root) && (path.startsWith("/") || path.startsWith("~/")) && !path.startsWith(`${root}/`);
  const name = isOutsideWorkspace ? collapseHome(path) : basename(path);
  return line ? `${name}:${line}` : name;
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
