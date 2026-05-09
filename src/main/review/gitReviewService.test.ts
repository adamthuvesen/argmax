// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
      changedFiles: 2
    });
    const service = new GitReviewService(database);

    const files = await service.listChangedFiles(workspace.id);
    const diff = await service.loadDiff(workspace.id, "src/index.ts");

    expect(files).toEqual([
      { status: "M", path: "src/index.ts" },
      { status: "??", path: "src/new.ts" }
    ]);
    expect(diff).toMatchObject({
      workspaceId: workspace.id,
      filePath: "src/index.ts"
    });
    expect(diff.content).toContain("-export const ok = true;");
    expect(diff.content).toContain("+export const ok = false;");

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
  git(repoPath, ["add", "src/index.ts"]);
  git(repoPath, ["commit", "-m", "test: seed repo"]);
  return repoPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
