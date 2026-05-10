import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { MaestroDatabase } from "../persistence/database.js";
import type { ChangedFileSummary, WorkspaceDiff } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

export class GitReviewService {
  constructor(private readonly database: MaestroDatabase) {}

  async listChangedFiles(workspaceId: string): Promise<ChangedFileSummary[]> {
    const workspace = this.database.getWorkspace(workspaceId);
    // `--porcelain=v1 -z` emits NUL-delimited records with literal paths
    // (no quoting, no octal escapes), so we don't have to unquote git's
    // human-readable form. The byte after each path is NUL, not LF.
    const porcelain = await git(workspace.path, ["status", "--porcelain=v1", "-z"]);
    const files = parsePorcelainZ(porcelain);
    return Promise.all(
      files.map(async (file) => {
        const content = await this.loadFileDiff(workspace.path, file);
        const counts = countDiffLines(content);
        return { ...file, ...counts };
      })
    );
  }

  async loadDiff(workspaceId: string, filePath?: string): Promise<WorkspaceDiff> {
    const workspace = this.database.getWorkspace(workspaceId);
    let content: string;
    if (filePath !== undefined) {
      assertSafeRelativePath(workspace.path, filePath);
      const file = parsePorcelainZ(await git(workspace.path, ["status", "--porcelain=v1", "-z", "--", filePath])).find(
        (item) => item.path === filePath
      );
      content = file ? await this.loadFileDiff(workspace.path, file) : await git(workspace.path, ["diff", "HEAD", "--", filePath]);
    } else {
      const files = parsePorcelainZ(await git(workspace.path, ["status", "--porcelain=v1", "-z"]));
      const diffs = await Promise.all(files.map((file) => this.loadFileDiff(workspace.path, file)));
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
    return git(workspacePath, ["diff", "HEAD", "--", file.path]);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  // Match the workspace git() helper: bounded timeout and a buffer large
  // enough for typical review diffs but not unboundedly so. Larger binary
  // diffs go through checkpointService with its own 256 MiB cap.
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8"
  });
  return stdout;
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
  assertSafeRelativePath(workspacePath, filePath);
  const content = await readFile(resolve(workspacePath, filePath), "utf8");
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
 * Assert filePath is a safe relative pathspec for a git worktree.
 *
 * Validation matches the `relativeFilePathSchema` in shared/ipcSchemas.ts
 * so a renderer-side type-checker drift can't smuggle in absolute paths,
 * `..`, or leading `-`. We additionally resolve the path against the
 * workspace root and require the canonical result to stay inside —
 * defense against symlinks crafted to redirect the diff into another tree.
 */
function assertSafeRelativePath(workspaceRoot: string, filePath: string): void {
  if (filePath.length === 0) {
    throw new Error("filePath must not be empty");
  }
  if (filePath.startsWith("-")) {
    throw new Error("filePath cannot start with '-'");
  }
  if (isAbsolute(filePath) || filePath.startsWith("/")) {
    throw new Error("filePath must be relative");
  }
  if (filePath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error("filePath cannot contain '..' segments");
  }
  const resolved = resolve(workspaceRoot, filePath);
  const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error("filePath escapes the workspace root");
  }
}
