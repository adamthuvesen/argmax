import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ArgmaxDatabase } from "../persistence/database.js";
import { PROVIDER_MODEL_DEFAULTS } from "../../shared/providerModels.js";
import type { ProjectSettings, ProjectSummary, RegisterProjectInput, RemoveProjectInput, UpdateProjectSettingsInput } from "../../shared/types.js";
import type { WorkspaceService } from "../workspaces/workspaceOrchestration.js";
import type { AttachmentStore } from "../attachments/attachmentStore.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { runGitMaybe, runGitText } from "../git/exec.js";

const execFileAsync = promisify(execFile);

interface GitMetadata {
  repoPath: string;
  currentBranch: string;
  defaultBranch: string | null;
}

export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

/**
 * Run a filesystem op (realpath/stat/etc.) and convert any throw into a
 * `ProjectRegistrationError` with the supplied prefix. The two raw `try`
 * blocks this replaces were structurally identical — only the error prefix
 * differed.
 */
async function runFsOp<T>(op: () => Promise<T>, prefix: string): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const detail = errorMessage(error) || "Unknown filesystem error";
    throw new ProjectRegistrationError(`${prefix} ${detail}`);
  }
}

export class ProjectService {
  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly workspaces?: WorkspaceService,
    private readonly attachments?: AttachmentStore
  ) {}

  async registerProject(input: RegisterProjectInput): Promise<ProjectSummary> {
    const canonicalPath = await canonicalizeRepoPath(input.repoPath);
    const metadata = await readGitMetadata(canonicalPath);
    // Validate baseRef-style refs at registration: catches ref strings the
    // zod boundary cannot detect (e.g. "@", trailing slashes) before they
    // ever flow into argv. defaultBranch is the only ref persisted here.
    if (metadata.defaultBranch) {
      await assertValidRefName(metadata.repoPath, metadata.defaultBranch);
    }
    const settings = defaultSettings(metadata.repoPath);

    return this.database.persistProject({
      id: randomUUID(),
      name: basename(metadata.repoPath),
      repoPath: metadata.repoPath,
      currentBranch: metadata.currentBranch,
      defaultBranch: metadata.defaultBranch,
      settings
    });
  }

  updateSettings(input: UpdateProjectSettingsInput): ProjectSummary {
    return this.database.updateProjectSettings(input.projectId, input.settings);
  }

  /**
   * Forget a project: remove its row from SQLite (cascading to workspaces,
   * sessions, events, approvals, checks, learnings, tournaments, etc.) and
   * close any open file watchers for its workspaces. Files on disk are left
   * untouched — the user can re-add the project later and the repo remains
   * exactly as they left it.
   *
   * Refuses when any session in the project is still running so we don't
   * orphan a provider process writing to a row that's about to vanish. The
   * caller should ask the user to stop those sessions first.
   */
  removeProject(input: RemoveProjectInput): { projectId: string } {
    const project = this.database.getProject(input.projectId);

    const snapshot = this.database.listWorkspaceStatus();
    const projectWorkspaceIds = new Set(
      snapshot.workspaces
        .filter((workspace) => workspace.projectId === input.projectId)
        .map((workspace) => workspace.id)
    );

    const runningInProject = snapshot.sessions.some(
      (session) => session.state === "running" && projectWorkspaceIds.has(session.workspaceId)
    );
    if (runningInProject) {
      throw new ProjectRegistrationError(
        `Stop the running sessions in "${project.name}" before removing the project.`
      );
    }

    if (this.workspaces) {
      this.workspaces.closeWatchersForWorkspaces([...projectWorkspaceIds]);
    }

    // Snapshot the affected session IDs BEFORE deletion so the cascading
    // session row removal doesn't strand their attachments on disk under
    // userData. (audit-2026-05-17 M15)
    const affectedSessionIds = snapshot.sessions
      .filter((session) => projectWorkspaceIds.has(session.workspaceId))
      .map((session) => session.id);

    this.database.deleteProject(input.projectId);

    if (this.attachments && affectedSessionIds.length > 0) {
      void Promise.all(
        affectedSessionIds.map((sessionId) =>
          this.attachments!.pruneSession(sessionId).catch((error) =>
            logger.warn("projects.removeProject", "attachment prune failed", {
              projectId: input.projectId,
              sessionId,
              error: errorMessage(error)
            })
          )
        )
      );
    }
    return { projectId: input.projectId };
  }
}

async function canonicalizeRepoPath(candidatePath: string): Promise<string> {
  const resolved = await runFsOp(() => realpath(candidatePath), `Argmax could not resolve ${candidatePath}.`);
  const stats = await runFsOp(() => stat(resolved), `Argmax could not stat ${resolved}.`);
  if (!stats.isDirectory()) {
    throw new ProjectRegistrationError(`${resolved} is not a directory.`);
  }
  // Require a `.git` entry — file (worktree linked) or directory — so we
  // refuse paths that just happen to live inside a repo but are not the
  // repo root. `git rev-parse --show-toplevel` below will canonicalize to
  // the actual root.
  try {
    await stat(join(resolved, ".git"));
  } catch {
    throw new ProjectRegistrationError(`${resolved} is not a git repository (.git missing).`);
  }
  return resolved;
}

async function assertValidRefName(repoPath: string, ref: string): Promise<void> {
  // `--allow-onelevel` permits short branch names (e.g. "main"); without it
  // `check-ref-format` would reject any ref without a slash. We deliberately
  // avoid `--branch` because that triggers DWIM expansion and we want
  // to refuse refs like `@{-1}` that resolve to historical state.
  try {
    await execFileAsync("git", ["-C", repoPath, "check-ref-format", "--allow-onelevel", ref]);
  } catch {
    throw new ProjectRegistrationError(`Invalid git ref name: ${ref}`);
  }
}

async function readGitMetadata(candidatePath: string): Promise<GitMetadata> {
  try {
    const root = (await runGitText(candidatePath, ["rev-parse", "--show-toplevel"])).trim();
    const currentBranch = (await runGitText(root, ["branch", "--show-current"])).trim() || "HEAD";
    const defaultBranch = await discoverDefaultBranch(root, currentBranch);

    return {
      repoPath: root,
      currentBranch,
      defaultBranch
    };
  } catch (error) {
    throw new ProjectRegistrationError(
      `Argmax requires a local git repository. ${errorMessage(error) || "Unknown git error"}`
    );
  }
}

async function discoverDefaultBranch(repoPath: string, currentBranch: string): Promise<string | null> {
  const originHead = await runGitMaybe(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    return originHead.trim().replace(/^origin\//, "");
  }

  // Probe all conventional default-branch names in parallel and pick the
  // first that exists in preferred order. Cold-disk serial probes were three
  // round-trips on registration; this is one.
  const candidates = ["main", "master", "trunk"] as const;
  const results = await Promise.all(
    candidates.map((branch) => runGitMaybe(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))
  );
  for (let i = 0; i < candidates.length; i++) {
    if (results[i] !== null) return candidates[i];
  }

  return currentBranch === "HEAD" ? null : currentBranch;
}

function defaultSettings(repoPath: string): ProjectSettings {
  return {
    defaultProvider: "codex",
    defaultModelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
    worktreeLocation: join(repoPath, ".argmax", "worktrees"),
    setupCommand: "",
    checkCommands: []
  };
}
