// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { GitReviewService } from "./gitReviewService.js";

describe("GitReviewService", () => {
  it("loads changed files and diffs for a workspace", async () => {
    const repoPath = createCommittedGitRepo();
    writeFileSync(join(repoPath, "src/index.ts"), "export const ok = false;\n");
    writeFileSync(join(repoPath, "src/new.ts"), "export const added = true;\n");
    writeFileSync(join(repoPath, "src/staged.ts"), "export const staged = true;\n");
    git(repoPath, ["add", "src/staged.ts"]);
    unlinkSync(join(repoPath, "src/delete-me.ts"));
    const database = createDatabase(":memory:", { seed: false });
    database.persistProject({
      id: "project-1",
      name: "Fixture",
      repoPath,
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex Spark Low",
        worktreeLocation: join(repoPath, ".worktrees"),
        setupCommand: "",
        checkCommands: []
      }
    });
    const workspace = database.persistWorkspace({
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Review",
      branch: "main",
      baseRef: "main",
      path: repoPath,
      state: "complete",
      sharedWorkspace: true,
      dirty: true,
      changedFiles: 4
    });
    const service = new GitReviewService(database);

    const files = await service.listChangedFiles(workspace.id);
    const diff = await service.loadDiff(workspace.id, "src/index.ts");
    const stagedDiff = await service.loadDiff(workspace.id, "src/staged.ts");
    const untrackedDiff = await service.loadDiff(workspace.id, "src/new.ts");
    const deletedDiff = await service.loadDiff(workspace.id, "src/delete-me.ts");

    expect(files).toEqual([
      { status: "D", path: "src/delete-me.ts", additions: 0, deletions: 1 },
      { status: "M", path: "src/index.ts", additions: 1, deletions: 1 },
      { status: "A", path: "src/staged.ts", additions: 1, deletions: 0 },
      { status: "??", path: "src/new.ts", additions: 1, deletions: 0 }
    ]);
    expect(diff).toMatchObject({
      workspaceId: workspace.id,
      filePath: "src/index.ts"
    });
    expect(diff.content).toContain("-export const ok = true;");
    expect(diff.content).toContain("+export const ok = false;");
    expect(stagedDiff.content).toContain("+export const staged = true;");
    expect(untrackedDiff.content).toContain("--- /dev/null");
    expect(untrackedDiff.content).toContain("+export const added = true;");
    expect(deletedDiff.content).toContain("-export const remove = true;");

    database.connection.close();
  });

  it("skips untracked directories without crashing on readFile", async () => {
    const repoPath = createCommittedGitRepo();
    mkdirSync(join(repoPath, "src/untracked-dir"));
    writeFileSync(join(repoPath, "src/untracked-dir/inside.txt"), "hi\n");
    const database = createDatabase(":memory:", { seed: false });
    database.persistProject({
      id: "project-1",
      name: "Fixture",
      repoPath,
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex Spark Low",
        worktreeLocation: join(repoPath, ".worktrees"),
        setupCommand: "",
        checkCommands: []
      }
    });
    const workspace = database.persistWorkspace({
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Review",
      branch: "main",
      baseRef: "main",
      path: repoPath,
      state: "complete",
      sharedWorkspace: true,
      dirty: true,
      changedFiles: 1
    });
    const service = new GitReviewService(database);

    const files = await service.listChangedFiles(workspace.id);
    expect(files.some((file) => file.path.endsWith("/"))).toBe(false);
    expect(files.some((file) => file.path === "src/untracked-dir/")).toBe(false);

    // Even if a caller hands a directory path directly to loadDiff, it must
    // not throw EISDIR — synthesizeUntrackedDiff returns an empty body.
    const diff = await service.loadDiff(workspace.id, "src/untracked-dir/");
    expect(diff.content).toBe("");

    database.connection.close();
  });

  it("shows untracked symlink targets without reading outside-workspace contents", async () => {
    const repoPath = createCommittedGitRepo();
    const outsidePath = join(tmpdir(), `maestro-secret-${Date.now()}.txt`);
    writeFileSync(outsidePath, "do not show me\n");
    symlinkSync(outsidePath, join(repoPath, "src/link.txt"));
    const database = createDatabase(":memory:", { seed: false });
    database.persistProject({
      id: "project-1",
      name: "Fixture",
      repoPath,
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.3 Codex Spark Low",
        worktreeLocation: join(repoPath, ".worktrees"),
        setupCommand: "",
        checkCommands: []
      }
    });
    const workspace = database.persistWorkspace({
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Review",
      branch: "main",
      baseRef: "main",
      path: repoPath,
      state: "complete",
      sharedWorkspace: true,
      dirty: true,
      changedFiles: 1
    });
    const service = new GitReviewService(database);

    const diff = await service.loadDiff(workspace.id, "src/link.txt");

    expect(diff.content).toContain("new file mode 120000");
    expect(diff.content).toContain(`+${outsidePath}`);
    expect(diff.content).not.toContain("do not show me");

    database.connection.close();
  });
});

function createCommittedGitRepo(): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "maestro-review-")));
  git(repoPath, ["init", "--initial-branch=main"]);
  git(repoPath, ["config", "user.email", "maestro@example.test"]);
  git(repoPath, ["config", "user.name", "Maestro Test"]);
  mkdirSync(join(repoPath, "src"));
  writeFileSync(join(repoPath, "src/index.ts"), "export const ok = true;\n");
  writeFileSync(join(repoPath, "src/delete-me.ts"), "export const remove = true;\n");
  git(repoPath, ["add", "src/index.ts", "src/delete-me.ts"]);
  git(repoPath, ["commit", "-m", "test: seed repo"]);
  return repoPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
