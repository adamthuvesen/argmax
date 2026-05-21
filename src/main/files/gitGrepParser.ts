import type {
  WorkspaceContentSearchFile,
  WorkspaceContentSearchResult
} from "../../shared/types.js";

/** Cap on the per-line snippet shipped to the renderer. Long minified lines
 *  would otherwise blow the IPC envelope and the UI cell. */
const MAX_PREVIEW_CHARS = 320;

/**
 * Parse `git grep -n --null -z` (or `--name-only` not applicable here) output.
 *
 * With `-z --null`, git emits NUL between every output field AND between match
 * records. The shape of one match is:
 *
 *     <path>\0<lineNumber>\0<lineContent>\0
 *
 * (Earlier git versions used `\0<line>\0:<content>` with a colon separator;
 *  modern git ≥2.43 drops the colon when `--null` is paired with `-z`. We
 *  defensively strip a leading colon to handle both.)
 *
 * Result is grouped by path in the order the matches appeared (git emits
 * matches in path-sorted order with multiple matches per file contiguous),
 * trimmed to `maxFiles` files and `maxMatchesPerFile` matches per file. If
 * the trim hits any cap, `truncated` is true so the renderer can show
 * "first N of many" copy.
 */
export function parseGitGrepOutput(
  raw: string,
  options: {
    maxFiles: number;
    maxMatchesPerFile: number;
  }
): WorkspaceContentSearchResult {
  if (!raw) return { files: [], truncated: false };
  const fields = raw.split("\0");
  // Trailing NUL adds one trailing empty string; drop it (at most one).
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();

  const filesByPath = new Map<string, WorkspaceContentSearchFile>();
  let truncated = false;

  for (let i = 0; i + 2 < fields.length; ) {
    const path = fields[i];
    const lineRaw = fields[i + 1];
    const previewRaw = fields[i + 2];
    if (path === undefined || lineRaw === undefined || previewRaw === undefined) break;
    const line = Number.parseInt(lineRaw, 10);
    if (!Number.isFinite(line)) {
      // Not a valid record — skip one field and try again.
      i += 1;
      continue;
    }
    const preview = (previewRaw.startsWith(":") ? previewRaw.slice(1) : previewRaw).slice(
      0,
      MAX_PREVIEW_CHARS
    );

    let bucket = filesByPath.get(path);
    if (!bucket) {
      if (filesByPath.size >= options.maxFiles) {
        truncated = true;
        i += 3;
        continue;
      }
      bucket = { path, matches: [] };
      filesByPath.set(path, bucket);
    }
    if (bucket.matches.length < options.maxMatchesPerFile) {
      bucket.matches.push({ line, preview });
    } else {
      truncated = true;
    }
    i += 3;
  }

  return { files: Array.from(filesByPath.values()), truncated };
}
