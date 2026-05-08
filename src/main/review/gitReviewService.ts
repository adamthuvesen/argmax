import { execFile } from "node:child_process";
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
    return parsePorcelainZ(porcelain);
  }

  async loadDiff(workspaceId: string, filePath?: string): Promise<WorkspaceDiff> {
    const workspace = this.database.getWorkspace(workspaceId);
    let args: string[];
    if (filePath !== undefined) {
      assertSafeRelativePath(workspace.path, filePath);
      args = ["diff", "--", filePath];
    } else {
      args = ["diff"];
    }
    const content = await git(workspace.path, args);

    return {
      workspaceId,
      filePath: filePath ?? null,
      content
    };
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
 * bytes, a space, the path, then NUL. Renames/copies emit two paths
 * separated by their own NUL: `XY old\0new\0`. We surface the new path
 * only, matching the existing v1 behavior.
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
    // Renames/copies: XY codes start with R or C and the next record is
    // the original path. Consume it and use the destination (current) path.
    const code = record.slice(0, 2);
    if (code.startsWith("R") || code.startsWith("C")) {
      // The destination path is what we already captured; skip the source.
      i += 1;
    }
    out.push({ status, path });
  }
  return out;
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
