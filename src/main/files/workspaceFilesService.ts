import { lstat, open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { WorkspaceFileEntry, WorkspaceFilePreview } from "../../shared/types.js";
import { runGitText } from "../git/exec.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/workspacePaths.js";

/** Files larger than this are skipped — preview is not a download manager. */
const MAX_PREVIEW_BYTES = 1_048_576;

/** Header sample read for binary detection (NUL byte sniff). */
const BINARY_SNIFF_BYTES = 4096;

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
    return { kind: "text", content, size: stats.size };
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
