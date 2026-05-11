import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { WorkspaceSummary } from "../../shared/types.js";
import { runGitText } from "../git/exec.js";

const execFileAsync = promisify(execFile);

/** Re-export for tests that exercise the timeout / maxBuffer / stderr-surfacing contract. */
export const git = runGitText;

export interface CreateWorkspaceInput {
  projectId: string;
  taskLabel: string;
  baseRef?: string;
}

export interface CurrentWorkspaceInput {
  projectId: string;
  taskLabel: string;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly recoverableAction: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Trailing-edge coalescing window for fs.watch bursts (e.g. `npm install`). */
const WATCH_DEBOUNCE_MS = 200;

interface WatchState {
  debounceTimer: NodeJS.Timeout | null;
  inFlight: boolean;
  pending: boolean;
}

export class WorkspaceService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchState = new Map<string, WatchState>();

  constructor(private readonly database: ArgmaxDatabase) {}

  async createIsolatedWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    const project = this.database.getProject(input.projectId);
    const baseRef = input.baseRef ?? project.defaultBranch ?? project.currentBranch;

    if (baseRef.startsWith("-")) {
      throw new WorkspaceError(
        `Invalid base ref ${baseRef}: cannot start with '-'`,
        "Choose a valid base ref and retry."
      );
    }
    // Belt-and-suspenders: zod blocks leading "-" but check-ref-format
    // catches other malformed refs (whitespace, control chars, "..", "@{").
    await assertValidRef(project.repoPath, baseRef);

    const branch = `argmax/${slugify(input.taskLabel)}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // 16 hex chars = 64 bits of entropy. Birthday-paradox 50% collision after
    // ~5.1B branches; at 100 branches/day a single user reaches 1% collision
    // probability after ~6M years. The previous 8-hex slice (32 bits) hit 1%
    // around 9,000 branches — too narrow for power users.
    const worktreePath = join(project.settings.worktreeLocation, branch.replace(/\//g, "-"));

    // Validate worktreeLocation lies inside repoPath (or under it). We resolve
    // both via realpath after creating the directory so symlinks cannot
    // smuggle the worktree outside the repo. Also requires the project's
    // repoPath to remain readable on disk.
    await mkdir(project.settings.worktreeLocation, { recursive: true });
    await assertWorktreeLocationContained(project.repoPath, project.settings.worktreeLocation);

    // Pre-flight: detect branch-name collision early so the error message
    // tells the user what to retry instead of relying on git's terse output.
    const branchExists = await runGitText(project.repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
      .then(() => true)
      .catch(() => false);
    if (branchExists) {
      throw new WorkspaceError(
        `Branch ${branch} already exists`,
        "Retry with a different task label."
      );
    }

    try {
      // `--` separates flags from positional pathspec/ref args. `worktree add`
      // does not strictly require it, but we keep the convention so a future
      // refactor cannot accidentally let a `-`-prefixed argument become a flag.
      await runGitText(project.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown git error";
      throw new WorkspaceError(`Could not create worktree for ${branch}. ${detail}`, "Choose another base ref or branch name and retry.");
    }

    return this.database.persistWorkspace({
      id: randomUUID(),
      projectId: project.id,
      taskLabel: input.taskLabel,
      branch,
      baseRef,
      path: worktreePath,
      state: "created",
      sharedWorkspace: false,
      dirty: false,
      changedFiles: 0
    });
  }

  createCurrentWorkspaceSession(input: CurrentWorkspaceInput): WorkspaceSummary {
    const project = this.database.getProject(input.projectId);

    return this.database.persistWorkspace({
      id: randomUUID(),
      projectId: project.id,
      taskLabel: input.taskLabel,
      branch: project.currentBranch,
      baseRef: project.currentBranch,
      path: project.repoPath,
      state: "created",
      sharedWorkspace: true,
      dirty: false,
      changedFiles: 0
    });
  }

  updateLifecycleState(workspaceId: string, state: WorkspaceSummary["state"]): WorkspaceSummary {
    return this.database.updateWorkspaceState(workspaceId, state);
  }

  keepWorkspace(workspaceId: string): WorkspaceSummary {
    return this.database.updateWorkspaceState(workspaceId, "kept");
  }

  async archiveWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = await this.refreshGitStatus(workspaceId);
    if (workspace.dirty) {
      this.closeWatcher(workspaceId);
      return this.database.updateWorkspaceState(workspaceId, "kept");
    }

    if (!workspace.sharedWorkspace) {
      const project = this.database.getProject(workspace.projectId);
      // Re-check porcelain immediately before remove to close the TOCTOU
      // window between refreshGitStatus and worktree remove. A file added
      // between the two calls would otherwise be lost.
      const recheck = await runGitText(workspace.path, ["status", "--porcelain"]);
      if (recheck.trim().length > 0) {
        this.closeWatcher(workspaceId);
        return this.database.updateWorkspaceState(workspaceId, "kept");
      }

      // Close the watcher before remove so file events from the disappearing
      // worktree don't fire ENOENT-spam refresh attempts during teardown.
      this.closeWatcher(workspaceId);

      try {
        await runGitText(project.repoPath, ["worktree", "remove", workspace.path]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown git error";
        throw new WorkspaceError(`Could not archive clean worktree. ${detail}`, "Review the worktree and retry archive.");
      }
    } else {
      this.closeWatcher(workspaceId);
    }

    return this.database.updateWorkspaceState(workspaceId, "archived");
  }

  async refreshGitStatus(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = this.database.getWorkspace(workspaceId);
    const branch = (await runGitText(workspace.path, ["branch", "--show-current"])).trim() || workspace.branch;
    const porcelain = await runGitText(workspace.path, ["status", "--porcelain"]);
    const changedFiles = porcelain
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;

    if (branch !== workspace.branch) {
      // Persist a timeline event when the workspace's HEAD branch moves out
      // from under us (e.g. the user manually checked out a different branch
      // inside the worktree). The session id is the workspace id as a stable
      // session-less anchor; consumers filter by payload.kind. Re-using the
      // `file.changed` EventType keeps this addition non-breaking until a
      // dedicated `branch-changed` type lands in shared/types.
      try {
        this.database.persistTimelineEvent({
          id: randomUUID(),
          sessionId: workspaceId,
          type: "file.changed",
          message: `Branch changed from ${workspace.branch} to ${branch}`,
          payload: {
            kind: "branch-changed",
            workspaceId,
            previousBranch: workspace.branch,
            currentBranch: branch
          }
        });
      } catch {
        // Timeline event persistence is best-effort. A failure should not
        // block the status refresh itself.
      }
    }

    return this.database.updateWorkspaceStatus(workspaceId, {
      branch,
      dirty: changedFiles > 0,
      changedFiles
    });
  }

  watchWorkspace(workspaceId: string): () => void {
    // Replace any prior watcher for the same id — a stale FSWatcher would
    // otherwise outlive its replacement and keep recursive kernel watches
    // alive until process exit.
    this.closeWatcher(workspaceId);

    const workspace = this.database.getWorkspace(workspaceId);
    const state: WatchState = { debounceTimer: null, inFlight: false, pending: false };
    this.watchState.set(workspaceId, state);

    // recursive: true is the macOS/Windows hot path. On Linux this is a no-op
    // (Node falls back to the directory-only watch); if a Linux user reports
    // missed updates the documented fallback is chokidar (see design.md
    // "Open Questions"). persistent: false keeps Node from holding the event
    // loop open just because of the watcher.
    const watcher = watch(workspace.path, { persistent: false, recursive: true }, () => {
      this.scheduleStatusRefresh(workspaceId);
    });
    watcher.on("error", () => {
      // fs.watch surfaces errors via the EventEmitter; if we don't listen,
      // an unhandled "error" event crashes the process.
      this.closeWatcher(workspaceId);
    });
    this.watchers.set(workspaceId, watcher);

    return () => this.closeWatcher(workspaceId);
  }

  /**
   * Trailing-edge debounce + single-flight gate around `refreshGitStatus`.
   * A burst like `npm install` would otherwise spawn one git child per fs
   * event; we coalesce into one refresh per 200 ms quiet window, and never
   * run two in parallel for the same workspace.
   */
  private scheduleStatusRefresh(workspaceId: string): void {
    const state = this.watchState.get(workspaceId);
    if (!state) return;
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void this.runStatusRefresh(workspaceId);
    }, WATCH_DEBOUNCE_MS);
    if (typeof state.debounceTimer.unref === "function") {
      state.debounceTimer.unref();
    }
  }

  private async runStatusRefresh(workspaceId: string): Promise<void> {
    const state = this.watchState.get(workspaceId);
    if (!state) return;
    if (state.inFlight) {
      // A refresh is already running. Mark pending so we re-run once it
      // finishes — guarantees no event silently disappears.
      state.pending = true;
      return;
    }
    state.inFlight = true;
    try {
      await this.refreshGitStatus(workspaceId);
    } catch {
      // Best-effort refresh: ENOENT during teardown, transient git lock
      // contention, or removed-worktree races are expected. Swallow.
    } finally {
      state.inFlight = false;
      if (state.pending) {
        state.pending = false;
        void this.runStatusRefresh(workspaceId);
      }
    }
  }

  private closeWatcher(workspaceId: string): void {
    const state = this.watchState.get(workspaceId);
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    this.watchState.delete(workspaceId);
    const watcher = this.watchers.get(workspaceId);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    this.watchers.delete(workspaceId);
  }
}


async function assertWorktreeLocationContained(repoPath: string, worktreeLocation: string): Promise<void> {
  if (!isAbsolute(worktreeLocation)) {
    throw new WorkspaceError(
      `worktreeLocation must be absolute, got ${worktreeLocation}`,
      "Configure project.worktreeLocation to an absolute path inside the repo."
    );
  }
  const repoResolved = await realpath(repoPath);
  const worktreeResolved = await realpath(worktreeLocation);
  const repoPrefix = repoResolved.endsWith(sep) ? repoResolved : repoResolved + sep;
  if (worktreeResolved !== repoResolved && !worktreeResolved.startsWith(repoPrefix)) {
    throw new WorkspaceError(
      `worktreeLocation ${worktreeResolved} must be inside repoPath ${repoResolved}`,
      "Choose a worktree location inside the project's repo and retry."
    );
  }
}

async function assertValidRef(repoPath: string, ref: string): Promise<void> {
  // `--allow-onelevel` lets us accept short branch names like "main" or
  // "feature-x"; without it `check-ref-format` requires a slash. We never
  // pass user input to `--branch` because that flag does DWIM expansion
  // (e.g. `@{-1}` resolves to a previous branch) which we want to refuse.
  try {
    await execFileAsync(
      "git",
      ["-C", repoPath, "check-ref-format", "--allow-onelevel", ref],
      {
        timeout: 5_000,
        encoding: "utf8"
      }
    );
  } catch {
    throw new WorkspaceError(
      `Invalid git ref ${ref}`,
      "Pick a base ref that conforms to git's ref-format rules."
    );
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);

  return slug || "task";
}
