import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { MaestroDatabase } from "../persistence/database.js";
import type { WorkspaceSummary } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

const createWorkspaceInput = z.object({
  projectId: z.string().min(1),
  taskLabel: z.string().min(1),
  baseRef: z.string().min(1).optional()
});

const currentWorkspaceInput = z.object({
  projectId: z.string().min(1),
  taskLabel: z.string().min(1)
});

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

export class WorkspaceService {
  constructor(private readonly database: MaestroDatabase) {}

  async createIsolatedWorkspace(rawInput: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    const input = createWorkspaceInput.parse(rawInput);
    const project = this.database.getProject(input.projectId);
    const baseRef = input.baseRef ?? project.defaultBranch ?? project.currentBranch;
    const branch = `maestro/${slugify(input.taskLabel)}-${randomUUID().slice(0, 8)}`;
    const worktreePath = join(project.settings.worktreeLocation, branch.replace("/", "-"));

    await mkdir(project.settings.worktreeLocation, { recursive: true });

    try {
      await git(project.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
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

  createCurrentWorkspaceSession(rawInput: CurrentWorkspaceInput): WorkspaceSummary {
    const input = currentWorkspaceInput.parse(rawInput);
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
      return this.database.updateWorkspaceState(workspaceId, "kept");
    }

    if (!workspace.sharedWorkspace) {
      const project = this.database.getProject(workspace.projectId);
      try {
        await git(project.repoPath, ["worktree", "remove", workspace.path]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown git error";
        throw new WorkspaceError(`Could not archive clean worktree. ${detail}`, "Review the worktree and retry archive.");
      }
    }

    return this.database.updateWorkspaceState(workspaceId, "archived");
  }

  async refreshGitStatus(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = this.database.getWorkspace(workspaceId);
    const branch = (await git(workspace.path, ["branch", "--show-current"])).trim() || workspace.branch;
    const porcelain = await git(workspace.path, ["status", "--porcelain"]);
    const changedFiles = porcelain
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;

    return this.database.updateWorkspaceStatus(workspaceId, {
      branch,
      dirty: changedFiles > 0,
      changedFiles
    });
  }

  watchWorkspace(workspaceId: string): () => void {
    const workspace = this.database.getWorkspace(workspaceId);
    const watcher = watch(workspace.path, { persistent: false }, () => {
      void this.refreshGitStatus(workspaceId);
    });

    return () => watcher.close();
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (stderr.trim()) {
    return stdout;
  }
  return stdout;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);

  return slug || "task";
}
