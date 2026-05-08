// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { ProjectService } from "../projects/projectRegistration.js";
import { WorkspaceError, WorkspaceService } from "./workspaceOrchestration.js";

describe("WorkspaceService", () => {
  it("creates an isolated git worktree on a task branch", async () => {
    const repoPath = createCommittedGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);

    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Add review studio"
    });

    expect(workspace.sharedWorkspace).toBe(false);
    expect(workspace.state).toBe("created");
    expect(workspace.branch).toMatch(/^maestro\/add-review-studio-/);
    expect(git(workspace.path, ["branch", "--show-current"])).toBe(workspace.branch);

    database.connection.close();
  });

  it("reports recoverable worktree creation errors without persisting a workspace", async () => {
    const repoPath = createCommittedGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);

    await expect(
      service.createIsolatedWorkspace({
        projectId: project.id,
        taskLabel: "Broken base",
        baseRef: "missing-ref"
      })
    ).rejects.toBeInstanceOf(WorkspaceError);
    expect(database.loadDashboard().workspaces).toHaveLength(0);

    database.connection.close();
  });

  it("creates explicitly labeled current-workspace sessions", async () => {
    const repoPath = createCommittedGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);

    const workspace = service.createCurrentWorkspaceSession({
      projectId: project.id,
      taskLabel: "Use current checkout"
    });

    expect(workspace.sharedWorkspace).toBe(true);
    expect(workspace.path).toBe(repoPath);
    expect(workspace.branch).toBe("main");

    database.connection.close();
  });

  it("keeps dirty workspaces instead of removing them during archive", async () => {
    const repoPath = createCommittedGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Dirty attempt"
    });
    writeFileSync(join(workspace.path, "changed.txt"), "changed");

    const archived = await service.archiveWorkspace(workspace.id);

    expect(archived.state).toBe("kept");
    expect(archived.dirty).toBe(true);
    expect(archived.changedFiles).toBe(1);

    database.connection.close();
  });

  it("archives clean worktrees and tracks lifecycle state changes", async () => {
    const repoPath = createCommittedGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Clean attempt"
    });

    expect(service.updateLifecycleState(workspace.id, "running").state).toBe("running");
    const archived = await service.archiveWorkspace(workspace.id);

    expect(archived.state).toBe("archived");

    database.connection.close();
  });
});

function createCommittedGitRepo(): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "maestro-worktree-")));
  git(repoPath, ["init", "--initial-branch=main"]);
  git(repoPath, ["config", "user.email", "maestro@example.test"]);
  git(repoPath, ["config", "user.name", "Maestro Test"]);
  mkdirSync(join(repoPath, "src"));
  writeFileSync(join(repoPath, "src", "index.ts"), "export const ok = true;\n");
  git(repoPath, ["add", "src/index.ts"]);
  git(repoPath, ["commit", "-m", "test: seed repo"]);
  return repoPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
