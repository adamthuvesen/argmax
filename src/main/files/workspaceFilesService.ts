import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type {
  WorkspaceContentSearchResult,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult
} from "../../shared/types.js";
import { runGitMaybe, runGitText } from "../git/exec.js";
import { parseGitGrepOutput } from "./gitGrepParser.js";
import { MAX_FILE_CONTENT_BYTES } from "../../shared/ipcSchemas.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/workspacePaths.js";

/** Files larger than this are skipped — preview is not a download manager. */
const MAX_PREVIEW_BYTES = 1_048_576;

/** Header sample read for binary detection (NUL byte sniff). */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Writes larger than this are rejected. Shared with the IPC schema cap
 * (`MAX_FILE_CONTENT_BYTES` in `src/shared/ipcSchemas.ts`) so the schema
 * boundary and the file-IO boundary agree.
 */
const MAX_WRITE_BYTES = MAX_FILE_CONTENT_BYTES;

/**
 * File-tree + file-content service backing the right-panel "Files" view.
 * Listing is git-aware (tracked + untracked, respecting `.gitignore`) so the
 * tree mirrors what the user actually cares about — no `node_modules` noise.
 * Reads are size-capped and binary-aware so a stray click on a multi-MB asset
 * doesn't ship megabytes of garbage to the renderer.
 */
export class WorkspaceFilesService {
  constructor(private readonly database: ArgmaxDatabase) {}

  async listFiles(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    const workspace = this.database.getWorkspace(workspaceId);
    return this.listFilesAtPath(workspace.path);
  }

  async grepContentForWorkspace(workspaceId: string, query: string): Promise<WorkspaceContentSearchResult> {
    const workspace = this.database.getWorkspace(workspaceId);
    return this.grepContentAtPath(workspace.path, query);
  }

  async grepContentForProject(projectId: string, query: string): Promise<WorkspaceContentSearchResult> {
    const project = this.database.getProject(projectId);
    return this.grepContentAtPath(project.repoPath, query);
  }

  private async grepContentAtPath(repoPath: string, query: string): Promise<WorkspaceContentSearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { files: [], truncated: false };
    // `git grep` flags:
    //   -n              line numbers
    //   --null          NUL-separate fields (path / line / content)
    //   --no-color      strip ANSI; we render highlight separately
    //   -I              skip binaries
    //   -F              fixed string (treat query literally — no regex)
    //   --untracked     also include untracked-but-not-ignored files
    //   -e <pattern>    pattern separator so a query starting with '-' is
    //                   not parsed as a flag
    // git grep exits 1 when there are no matches — `runGitMaybe` swallows
    // that so an empty result isn't surfaced as an error.
    const output = await runGitMaybe(repoPath, [
      "grep",
      "-n",
      "--null",
      "--no-color",
      "-I",
      "-F",
      "--untracked",
      "-e",
      trimmed
    ]);
    if (output === null) return { files: [], truncated: false };
    return parseGitGrepOutput(output, { maxFiles: 50, maxMatchesPerFile: 10 });
  }

  async readFile(workspaceId: string, filePath: string): Promise<WorkspaceFilePreview> {
    const workspace = this.database.getWorkspace(workspaceId);
    return this.readFileAtPath(workspace.path, filePath);
  }

  async listFilesForProject(projectId: string): Promise<WorkspaceFileEntry[]> {
    const project = this.database.getProject(projectId);
    return this.listFilesAtPath(project.repoPath);
  }

  async readFileForProject(projectId: string, filePath: string): Promise<WorkspaceFilePreview> {
    const project = this.database.getProject(projectId);
    return this.readFileAtPath(project.repoPath, filePath);
  }

  private async listFilesAtPath(repoPath: string): Promise<WorkspaceFileEntry[]> {
    // `ls-files -z` emits NUL-terminated paths; combining `--cached` (tracked)
    // with `--others --exclude-standard` (untracked but not gitignored) gives
    // the same set a developer sees in their IDE. Duplicates can appear if a
    // file is tracked AND modified in the index, so we de-dupe.
    const output = await runGitText(repoPath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard"
    ]);
    const seen = new Set<string>();
    const entries: WorkspaceFileEntry[] = [];
    for (const path of output.split("\0")) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      entries.push({ path });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  private async readFileAtPath(repoPath: string, filePath: string): Promise<WorkspaceFilePreview> {
    assertSafeRelativePath(repoPath, filePath);
    const resolved = resolve(repoPath, filePath);

    const stats = await lstat(resolved);
    // Symlinks and directories are not previewable text. We never follow
    // symlinks for the preview — they could point outside the worktree.
    if (!stats.isFile()) {
      return { kind: "skipped", reason: "not-a-file" };
    }

    // Realpath check defends against TOCTOU where the path resolved cleanly
    // but the inode points outside the worktree (e.g. via a parent symlink).
    const repoRealPath = await realpath(repoPath);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(repoRealPath, fileRealPath, "filePath escapes the workspace root");

    if (stats.size > MAX_PREVIEW_BYTES) {
      return { kind: "skipped", reason: "too-large", size: stats.size };
    }

    // Read the inode we validated via realpath, not the symlinked alias. If a
    // symlink were swapped between the realpath check and the read, the
    // unresolved path could still redirect outside the workspace.
    if (await looksBinary(fileRealPath)) {
      return { kind: "skipped", reason: "binary", size: stats.size };
    }

    const content = await readFile(fileRealPath, "utf8");
    return { kind: "text", content, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  /**
   * Stat a worktree file for cheap mtime polling. Same path-safety pipeline as
   * `readFile` — workspace lookup, relative-path guard, lstat (no symlink
   * follow), realpath containment check. Returns the on-disk mtime so the
   * renderer can detect external mutations without re-reading the file body.
   */
  async statFile(workspaceId: string, filePath: string): Promise<WorkspaceFileStat> {
    const workspace = this.database.getWorkspace(workspaceId);
    return this.statFileAtPath(workspace.path, filePath);
  }

  async statFileForProject(projectId: string, filePath: string): Promise<WorkspaceFileStat> {
    const project = this.database.getProject(projectId);
    return this.statFileAtPath(project.repoPath, filePath);
  }

  /**
   * Write UTF-8 `content` to a worktree file with an ETag-style mtime guard.
   *
   * If `expectedMtimeMs` is not `null` and the on-disk mtime differs, we
   * refuse with `ok: false, reason: "stale"` so the renderer can surface the
   * "changed on disk, reload?" banner instead of clobbering an out-of-band
   * edit (typically a provider session mutating the same file).
   *
   * Path-safety mirrors `readFile`: the workspace lookup, relative-path
   * guard, `lstat` (no symlink follow), and `realpath` containment check all
   * apply. The write targets `fileRealPath` — the canonical inode validated
   * by realpath — not the unresolved path, so a swapped symlink between the
   * realpath check and the write can't redirect outside the worktree.
   */
  async writeFile(
    workspaceId: string,
    filePath: string,
    content: string,
    expectedMtimeMs: number | null
  ): Promise<WorkspaceFileWriteResult> {
    const workspace = this.database.getWorkspace(workspaceId);
    return this.writeFileAtPath(workspace.path, filePath, content, expectedMtimeMs);
  }

  async writeFileForProject(
    projectId: string,
    filePath: string,
    content: string,
    expectedMtimeMs: number | null
  ): Promise<WorkspaceFileWriteResult> {
    const project = this.database.getProject(projectId);
    return this.writeFileAtPath(project.repoPath, filePath, content, expectedMtimeMs);
  }

  private async statFileAtPath(repoPath: string, filePath: string): Promise<WorkspaceFileStat> {
    assertSafeRelativePath(repoPath, filePath);
    const resolved = resolve(repoPath, filePath);

    const stats = await lstat(resolved);
    if (!stats.isFile()) {
      throw new Error("filePath does not point to a regular file");
    }

    const repoRealPath = await realpath(repoPath);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(repoRealPath, fileRealPath, "filePath escapes the workspace root");

    return { mtimeMs: stats.mtimeMs, size: stats.size };
  }

  private async writeFileAtPath(
    repoPath: string,
    filePath: string,
    content: string,
    expectedMtimeMs: number | null
  ): Promise<WorkspaceFileWriteResult> {
    if (content.length > MAX_WRITE_BYTES) {
      throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    }
    assertSafeRelativePath(repoPath, filePath);
    const resolved = resolve(repoPath, filePath);

    const stats = await lstat(resolved);
    if (!stats.isFile()) {
      throw new Error("filePath does not point to a regular file");
    }

    const repoRealPath = await realpath(repoPath);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(repoRealPath, fileRealPath, "filePath escapes the workspace root");

    const parentRealPath = await realpath(dirname(fileRealPath));
    assertContainedPath(repoRealPath, parentRealPath, "filePath parent escapes the workspace root");

    if (expectedMtimeMs !== null && stats.mtimeMs !== expectedMtimeMs) {
      return {
        ok: false,
        reason: "stale",
        currentMtimeMs: stats.mtimeMs,
        size: stats.size
      };
    }

    // Open with O_NOFOLLOW so the path is rejected if it was symlink-swapped
    // between realpath() and now, and verify the inode hasn't changed —
    // together these close the TOCTOU window where an attacker could
    // redirect the write to an arbitrary file. (audit-2026-05-17 M3)
    const handle = await open(fileRealPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const fdStat = await handle.stat();
      if (fdStat.ino !== stats.ino) {
        throw new Error("File changed while opening for write");
      }
      await handle.truncate(0);
      const buf = Buffer.from(content, "utf8");
      await handle.write(buf, 0, buf.length, 0);
      const after = await handle.stat();
      return { ok: true, mtimeMs: after.mtimeMs, size: after.size };
    } finally {
      await handle.close();
    }
  }
}

/**
 * Heuristic: read the first few KB and look for a NUL byte. Matches what git
 * does for its own "binary" detection and is good enough to skip images,
 * compiled artefacts, and similar. Cheaper than a full mime sniff.
 */
async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}
