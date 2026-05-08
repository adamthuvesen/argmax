// @vitest-environment node
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import { CheckService } from "./checkService.js";

describe("CheckService", () => {
  it("persists successful check output", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const chunks: string[] = [];
    const service = new CheckService(database);

    const check = await service.runWorkspaceCheck({
      workspaceId,
      command: "node -e \"console.log('ok')\"",
      onOutput: (chunk) => chunks.push(chunk)
    });

    expect(check).toMatchObject({
      workspaceId,
      command: "node -e \"console.log('ok')\"",
      status: "passed",
      exitCode: 0,
      summary: "ok"
    });
    expect(chunks.join("")).toContain("ok");

    database.connection.close();
  });

  it("persists failed check output", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CheckService(database);

    const check = await service.runWorkspaceCheck({
      workspaceId,
      command: "node -e \"console.error('bad'); process.exit(2)\""
    });

    expect(check).toMatchObject({
      status: "failed",
      exitCode: 2,
      summary: "bad"
    });

    database.connection.close();
  });
});

function persistWorkspaceFixture(database: MaestroDatabase): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "maestro-check-")));
  database.persistProject({
    id: "project-1",
    name: "Fixture",
    repoPath,
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5 Codex",
      worktreeLocation: join(repoPath, ".worktrees"),
      setupCommand: "",
      checkCommands: []
    }
  });
  const workspace = database.persistWorkspace({
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Checks",
    branch: "main",
    baseRef: "main",
    path: repoPath,
    state: "complete",
    sharedWorkspace: true,
    dirty: false,
    changedFiles: 0
  });

  return workspace.id;
}
