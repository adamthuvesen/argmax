// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { CheckpointService } from "./checkpointService.js";

describe("CheckpointService", () => {
  it("creates a patch snapshot checkpoint for a workspace", async () => {
    const repoPath = createCommittedGitRepo();
    const checkpointDir = realpathSync(mkdtempSync(join(tmpdir(), "maestro-checkpoints-")));
    writeFileSync(join(repoPath, "src/index.ts"), "export const ok = false;\n");
    const database = createDatabase(":memory:", { seed: false });
    database.persistProject({
      id: "project-1",
      name: "Fixture",
      repoPath,
      currentBranch: "main",
      defaultBranch: "main",
      settings: {
        defaultProvider: "codex",
        defaultModelLabel: "GPT-5.5 Medium",
        worktreeLocation: join(repoPath, ".worktrees"),
        setupCommand: "",
        checkCommands: []
      }
    });
    const workspace = database.persistWorkspace({
      id: "workspace-1",
      projectId: "project-1",
      taskLabel: "Checkpoint",
      branch: "main",
      baseRef: "main",
      path: repoPath,
      state: "complete",
      sharedWorkspace: true,
      dirty: true,
      changedFiles: 1
    });
    const service = new CheckpointService(database, checkpointDir);

    const checkpoint = await service.createCheckpoint({
      workspaceId: workspace.id,
      label: "Before review"
    });

    expect(checkpoint).toMatchObject({
      workspaceId: workspace.id,
      label: "Before review",
      branch: "main"
    });
    expect(checkpoint.gitRef).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.patchPath).toContain(checkpointDir);
    expect(readFileSync(checkpoint.patchPath ?? "", "utf8")).toContain("+export const ok = false;");

    database.connection.close();
  });
});

function createCommittedGitRepo(): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "maestro-checkpoint-repo-")));
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
