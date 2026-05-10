import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { MaestroDatabase } from "../persistence/database.js";
import type { ChangedFileSummary, WorkspaceDiff } from "../../shared/types.js";
import { runGitText } from "../git/exec.js";

/** Cap on parallel `git diff` invocations when fetching all-files diff. */
const DIFF_FANOUT_LIMIT = 8;

export class GitReviewService {
  constructor(private readonly database: MaestroDatabase) {}

  async listChangedFiles(workspaceId: string): Promise<ChangedFileSummary[]> {
    const workspace = this.database.getWorkspace(workspaceId);
    // `--porcelain=v1 -z` emits NUL-delimited records with literal paths
    // (no quoting, no octal escapes), so we don't have to unquote git's
    // human-readable form. The byte after each path is NUL, not LF.
    const porcelain = await runGitText(workspace.path, ["status", "--porcelain=v1", "-z"]);
    const files = parsePorcelainZ(porcelain);
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
  const content = await readFile(safeAbsolutePath, "utf8");
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

/**
 * Resolve filePath against the workspace root and assert the canonical result
 * stays inside it — defense against symlinks or constructed paths that would
 * redirect the diff into another tree. Shape validation (no absolute paths,
 * no `..`, no leading `-`) is already enforced by `relativeFilePathSchema`
 * at the IPC boundary.
 */
function assertSafeRelativePath(workspaceRoot: string, filePath: string): void {
  const resolved = resolve(workspaceRoot, filePath);
  const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error("filePath escapes the workspace root");
  }
}
