import { lstat, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type {
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult
} from "../../shared/types.js";
import { runGitText } from "../git/exec.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/workspacePaths.js";

/** Files larger than this are skipped — preview is not a download manager. */
const MAX_PREVIEW_BYTES = 1_048_576;

/** Header sample read for binary detection (NUL byte sniff). */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Writes larger than this are rejected. 4× the preview cap so a user can paste
 * a sizeable blob and still save, but bounded enough that a runaway buffer
 * can't ship megabytes across the IPC boundary.
 */
const MAX_WRITE_BYTES = 4_194_304;

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
    // `ls-files -z` emits NUL-terminated paths; combining `--cached` (tracked)
    // with `--others --exclude-standard` (untracked but not gitignored) gives
    // the same set a developer sees in their IDE. Duplicates can appear if a
    // file is tracked AND modified in the index, so we de-dupe.
    const output = await runGitText(workspace.path, [
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

  async readFile(workspaceId: string, filePath: string): Promise<WorkspaceFilePreview> {
    const workspace = this.database.getWorkspace(workspaceId);
    assertSafeRelativePath(workspace.path, filePath);
    const resolved = resolve(workspace.path, filePath);

    const stats = await lstat(resolved);
    // Symlinks and directories are not previewable text. We never follow
    // symlinks for the preview — they could point outside the worktree.
    if (!stats.isFile()) {
      return { kind: "skipped", reason: "not-a-file" };
    }

    // Realpath check defends against TOCTOU where the path resolved cleanly
    // but the inode points outside the worktree (e.g. via a parent symlink).
    const workspaceRealPath = await realpath(workspace.path);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(workspaceRealPath, fileRealPath, "filePath escapes the workspace root");

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
    assertSafeRelativePath(workspace.path, filePath);
    const resolved = resolve(workspace.path, filePath);

    const stats = await lstat(resolved);
    if (!stats.isFile()) {
      throw new Error("filePath does not point to a regular file");
    }

    const workspaceRealPath = await realpath(workspace.path);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(workspaceRealPath, fileRealPath, "filePath escapes the workspace root");

    return { mtimeMs: stats.mtimeMs, size: stats.size };
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
    if (content.length > MAX_WRITE_BYTES) {
      throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    }
    const workspace = this.database.getWorkspace(workspaceId);
    assertSafeRelativePath(workspace.path, filePath);
    const resolved = resolve(workspace.path, filePath);

    const stats = await lstat(resolved);
    if (!stats.isFile()) {
      throw new Error("filePath does not point to a regular file");
    }

    const workspaceRealPath = await realpath(workspace.path);
    const fileRealPath = await realpath(resolved);
    assertContainedPath(workspaceRealPath, fileRealPath, "filePath escapes the workspace root");

    // Defense in depth: the realpath landed inside the worktree, but if the
    // path's *parent directory* points outside via a symlink swap, a future
    // write could still escape. Check the parent's realpath too.
    const parentRealPath = await realpath(dirname(fileRealPath));
    assertContainedPath(workspaceRealPath, parentRealPath, "filePath parent escapes the workspace root");

    if (expectedMtimeMs !== null && stats.mtimeMs !== expectedMtimeMs) {
      return {
        ok: false,
        reason: "stale",
        currentMtimeMs: stats.mtimeMs,
        size: stats.size
      };
    }

    await writeFile(fileRealPath, content, "utf8");
    const after = await stat(fileRealPath);
    return { ok: true, mtimeMs: after.mtimeMs, size: after.size };
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
