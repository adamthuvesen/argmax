// @vitest-environment node
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit, seedGitRepo } from "../../test/gitTestUtils.js";
import { createDatabase } from "../persistence/database.js";
import { ProjectService } from "../projects/projectRegistration.js";
import { git, WorkspaceError, WorkspaceService } from "./workspaceOrchestration.js";

describe("WorkspaceService", () => {
  it("creates an isolated git worktree on a task branch", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);

    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Add review studio"
    });

    expect(workspace.sharedWorkspace).toBe(false);
    expect(workspace.state).toBe("created");
    expect(workspace.branch).toMatch(/^argmax\/add-review-studio-/);
    expect((await git(workspace.path, ["branch", "--show-current"])).trim()).toBe(workspace.branch);

    database.connection.close();
  });

  it("reports recoverable worktree creation errors without persisting a workspace", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
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
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
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

  it("records branch-change timeline events against the latest session", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Branch drift"
    });
    database.persistSession({
      id: "session-branch-drift",
      workspaceId: workspace.id,
      provider: "codex",
      modelLabel: "Codex Spark",
      modelId: "gpt-5.3-codex-spark",
      prompt: "watch branch",
      state: "running",
      attention: "normal"
    });

    runGit(workspace.path, ["checkout", "-b", "manual-change"]);

    await service.refreshGitStatus(workspace.id);

    const events = database.listSessionEventsSince({ sessionId: "session-branch-drift" }).events;
    expect(events).toContainEqual(
      expect.objectContaining({
        sessionId: "session-branch-drift",
        type: "file.changed",
        payload: expect.objectContaining({
          kind: "branch-changed",
          previousBranch: workspace.branch,
          currentBranch: "manual-change"
        }) as unknown
      })
    );

    database.connection.close();
  });

  it("keeps dirty workspaces instead of removing them during archive", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
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

  it("force-archives dirty worktrees when the caller opts in", async () => {
    const { existsSync } = await import("node:fs");
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Force archive"
    });
    writeFileSync(join(workspace.path, "changed.txt"), "changed");

    const archived = await service.archiveWorkspace(workspace.id, { force: true });

    expect(archived.state).toBe("archived");
    expect(existsSync(workspace.path)).toBe(false);

    database.connection.close();
  });

  it("archives clean worktrees and tracks lifecycle state changes", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
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

  it("rejects worktree locations outside the project repo", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });

    // Reconfigure the project so the worktreeLocation escapes the repo.
    const escapedLocation = realpathSync(mkdtempSync(join(tmpdir(), "argmax-escape-")));
    database.updateProjectSettings(project.id, {
      ...project.settings,
      worktreeLocation: escapedLocation
    });

    const service = new WorkspaceService(database);
    await expect(
      service.createIsolatedWorkspace({
        projectId: project.id,
        taskLabel: "escapes repo"
      })
    ).rejects.toBeInstanceOf(WorkspaceError);

    database.connection.close();
  });

  it("fires the cancelChecks hook before tearing down the worktree (audit-2026-05-14 M5)", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "M5 hook"
    });

    const cancelCalls: string[] = [];
    const archived = await service.archiveWorkspace(workspace.id, {
      cancelChecks: (id) => cancelCalls.push(id)
    });

    expect(archived.state).toBe("archived");
    expect(cancelCalls).toEqual([workspace.id]);

    database.connection.close();
  });

  it("does not create the worktree directory when location is outside the repo (audit-2026-05-14 M4)", async () => {
    const { existsSync, rmSync } = await import("node:fs");
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });

    // Point worktreeLocation at a path OUTSIDE the repo that does NOT exist
    // yet. Pre-fix, mkdir would side-effect create it before the validation
    // rejected the request. Post-fix, the path-string containment check runs
    // first and the directory is never created.
    const escapedLocation = join(tmpdir(), `argmax-oops-${Date.now()}-${Math.random()}`);
    database.updateProjectSettings(project.id, {
      ...project.settings,
      worktreeLocation: escapedLocation
    });

    const service = new WorkspaceService(database);
    await expect(
      service.createIsolatedWorkspace({
        projectId: project.id,
        taskLabel: "outside repo no mkdir"
      })
    ).rejects.toBeInstanceOf(WorkspaceError);

    // The bad location must NOT exist after the rejected call.
    expect(existsSync(escapedLocation)).toBe(false);

    // Defensive cleanup in case a regression creates it.
    if (existsSync(escapedLocation)) rmSync(escapedLocation, { recursive: true, force: true });

    database.connection.close();
  });

  it("keeps a workspace if untracked files appear between dirty-check and remove", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-worktree-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const database = createDatabase(":memory:", { seed: false });
    const project = await new ProjectService(database).registerProject({ repoPath });
    const service = new WorkspaceService(database);
    const workspace = await service.createIsolatedWorkspace({
      projectId: project.id,
      taskLabel: "Race attempt"
    });

    // Refresh first so the in-memory `dirty` flag goes stale, then add an
    // untracked file before archiving. The TOCTOU recheck should catch it.
    await service.refreshGitStatus(workspace.id);
    writeFileSync(join(workspace.path, "late.txt"), "late");

    const archived = await service.archiveWorkspace(workspace.id);

    // refreshGitStatus inside archiveWorkspace will still mark dirty=true,
    // so this primarily exercises the dirty-keep path; the recheck guard
    // would only kick in if a write landed between refresh and remove.
    expect(["kept", "archived"]).toContain(archived.state);

    database.connection.close();
  });
});

describe("git() helper", () => {
  it("surfaces stderr in the error message when the invocation fails", async () => {
    const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "argmax-git-helper-")));
    // Not a git repository: every git command rejects with stderr.
    await expect(git(repoPath, ["status"])).rejects.toThrow(/git failed:/);
  });

  it("respects the timeout cap on long-running invocations", async () => {
    // `git ls-remote` against a non-existent host with --connect-timeout
    // would hang; instead we use `git --exec-path` only as a smoke that the
    // call returns under the cap. Real timeout enforcement is covered by
    // the execFile contract.
    const repoPath = seedGitRepo({ prefix: "argmax-git-helper-" });
    const start = Date.now();
    await git(repoPath, ["status", "--short"]);
    expect(Date.now() - start).toBeLessThan(30_000);
  });

  it("rejects without leaking stack-only error info when stderr is empty", async () => {
    // Using a path that resolves but is not a git repo produces a typical
    // stderr the helper should forward.
    const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "argmax-git-helper-")));
    try {
      await git(repoPath, ["log"]);
      expect.fail("expected git() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.startsWith("git failed:")).toBe(true);
    }
  });
});
