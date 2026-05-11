import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { ChangedFileSummary, WorkspaceDiff } from "../../shared/types.js";
import { runGitText } from "../git/exec.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/workspacePaths.js";

/** Cap on parallel `git diff` invocations when fetching all-files diff. */
const DIFF_FANOUT_LIMIT = 8;

export class GitReviewService {
  constructor(private readonly database: ArgmaxDatabase) {}

  async listChangedFiles(workspaceId: string): Promise<ChangedFileSummary[]> {
    const workspace = this.database.getWorkspace(workspaceId);
    // `--porcelain=v1 -z` emits NUL-delimited records with literal paths
    // (no quoting, no octal escapes), so we don't have to unquote git's
    // human-readable form. The byte after each path is NUL, not LF.
    const porcelain = await runGitText(workspace.path, ["status", "--porcelain=v1", "-z"]);
    // Untracked directories arrive as `?? dirname/` — drop them; readFile
    // on a directory would crash, and a 0/0 placeholder row is junk.
    const files = parsePorcelainZ(porcelain).filter((file) => !file.path.endsWith("/"));
    return mapWithConcurrency(files, DIFF_FANOUT_LIMIT, async (file) => {
      const content = await this.loadFileDiff(workspace.path, file);
      const counts = countDiffLines(content);
      return { ...file, ...counts };
    });
  }

  async loadDiff(workspaceId: string, filePath?: string): Promise<WorkspaceDiff> {
    const workspace = this.database.getWorkspace(workspaceId);
    let content: string;
    if (filePath !== undefined) {
      assertSafeRelativePath(workspace.path, filePath);
      const file = parsePorcelainZ(
        await runGitText(workspace.path, ["status", "--porcelain=v1", "-z", "--", filePath])
      ).find((item) => item.path === filePath);
      content = file
        ? await this.loadFileDiff(workspace.path, file)
        : await runGitText(workspace.path, ["diff", "HEAD", "--", filePath]);
    } else {
      const files = parsePorcelainZ(await runGitText(workspace.path, ["status", "--porcelain=v1", "-z"]));
      const diffs = await mapWithConcurrency(files, DIFF_FANOUT_LIMIT, (file) => this.loadFileDiff(workspace.path, file));
      content = diffs.filter(Boolean).join("\n");
    }

    return {
      workspaceId,
      filePath: filePath ?? null,
      content
    };
  }

  private async loadFileDiff(workspacePath: string, file: ChangedFileSummary): Promise<string> {
    if (file.status === "??") {
      return synthesizeUntrackedDiff(workspacePath, file.path);
    }
    return runGitText(workspacePath, ["diff", "HEAD", "--", file.path]);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parse `git status --porcelain=v1 -z` output. Each entry is two status
 * bytes, a space, the path, then NUL. In `-z` mode renames/copies emit the
 * destination path first, then the source path. We surface the destination
 * path and keep the source as oldPath.
 */
function parsePorcelainZ(value: string): ChangedFileSummary[] {
  if (!value) return [];
  const records = value.split("\0").filter((entry) => entry.length > 0);
  const out: ChangedFileSummary[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 3) continue;
    const status = record.slice(0, 2).trim() || "?";
    const path = record.slice(3);
    let oldPath: string | undefined;
    // Renames/copies: XY codes start with R or C and the next record is
    // the original path. Consume it and use the destination (current) path.
    const code = record.slice(0, 2);
    if (code.startsWith("R") || code.startsWith("C")) {
      // The destination path is what we already captured; skip the source.
      oldPath = records[i + 1];
      i += 1;
    }
    out.push({ status, path, additions: 0, deletions: 0, ...(oldPath ? { oldPath } : {}) });
  }
  return out;
}

function countDiffLines(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

async function synthesizeUntrackedDiff(workspacePath: string, filePath: string): Promise<string> {
  const safeAbsolutePath = resolve(workspacePath, filePath);
  assertSafeRelativePath(workspacePath, filePath);
  const stats = await lstat(safeAbsolutePath);
  if (stats.isSymbolicLink()) {
    const target = await readlink(safeAbsolutePath);
    return synthesizeUntrackedSymlinkDiff(filePath, target);
  }
  if (stats.isDirectory()) {
    return "";
  }
  const workspaceRealPath = await realpath(workspacePath);
  const fileRealPath = await realpath(safeAbsolutePath);
  assertContainedPath(workspaceRealPath, fileRealPath, "filePath escapes the workspace root");
  // Defense-in-depth: lstat said this wasn't a dir/symlink, but TOCTOU or
  // a caller bypassing the listChangedFiles filter could still land here
  // pointing at a directory or a vanished file.
  let content: string;
  try {
    content = await readFile(safeAbsolutePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EISDIR" || code === "ENOENT") {
      return "";
    }
    throw error;
  }
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = hasTrailingNewline ? "" : "\n\\ No newline at end of file";
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`
  ].join("\n");
}

function synthesizeUntrackedSymlinkDiff(filePath: string, target: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 120000",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    "@@ -0,0 +1 @@",
    `+${target}`,
    "\\ No newline at end of file"
  ].join("\n");
}

