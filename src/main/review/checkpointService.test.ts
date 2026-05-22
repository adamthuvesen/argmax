// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { runGit, seedGitRepo } from "../../test/gitTestUtils.js";
import { CheckpointService } from "./checkpointService.js";

describe("CheckpointService", () => {
  it("creates a patch snapshot checkpoint for a workspace", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-checkpoint-repo-",
      files: [{ path: "src/index.ts", contents: "export const ok = true;\n" }]
    });
    const checkpointDir = realpathSync(mkdtempSync(join(tmpdir(), "argmax-checkpoints-")));
    writeFileSync(join(repoPath, "src/index.ts"), "export const ok = false;\n");
    writeFileSync(join(repoPath, "src/new.ts"), "export const added = true;\n");
    writeFileSync(join(repoPath, "src/image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
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
    const patch = readFileSync(checkpoint.patchPath ?? "", "utf8");
    expect(patch).toContain("+export const ok = false;");
    expect(patch).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(patch).toContain("+export const added = true;");
    expect(patch).toContain("diff --git a/src/image.bin b/src/image.bin");
    expect(patch).toContain("GIT binary patch");
    expect(runGit(repoPath, ["status", "--porcelain"])).toContain("?? src/new.ts");
    expect(runGit(repoPath, ["status", "--porcelain"])).toContain("?? src/image.bin");

    database.connection.close();
  });
});
