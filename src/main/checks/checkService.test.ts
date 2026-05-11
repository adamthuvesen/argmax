// @vitest-environment node
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, type ArgmaxDatabase } from "../persistence/database.js";
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

  it("kills the process tree and records cancelled when aborted", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CheckService(database);
    const controller = new AbortController();

    // Start a long-running command and abort within ~100 ms. The detached
    // process-group kill should bring it down well before the test timeout.
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    const check = await service.runWorkspaceCheck({
      workspaceId,
      command: "node -e \"setTimeout(() => {}, 60000)\"",
      signal: controller.signal
    });
    const elapsed = Date.now() - start;

    expect(check.status).toBe("cancelled");
    expect(check.summary?.startsWith("[cancelled]")).toBe(true);
    expect(elapsed).toBeLessThan(10_000);

    database.connection.close();
  });

  it("times out long-running commands and records timed-out", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CheckService(database);

    const start = Date.now();
    const check = await service.runWorkspaceCheck({
      workspaceId,
      command: "node -e \"setTimeout(() => {}, 60000)\"",
      timeoutMs: 200
    });
    const elapsed = Date.now() - start;

    expect(check.status).toBe("cancelled");
    expect(check.summary?.startsWith("[timed-out]")).toBe(true);
    expect(elapsed).toBeLessThan(10_000);

    database.connection.close();
  });

  it("cancels every running child for a workspace via cancelWorkspaceChecks", async () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CheckService(database);

    const inflight = service.runWorkspaceCheck({
      workspaceId,
      command: "node -e \"setTimeout(() => {}, 60000)\""
    });
    // Give the child a moment to register before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.cancelWorkspaceChecks(workspaceId);

    const result = await inflight;
    // SIGTERM produces a non-zero exit; we don't assert exact status because
    // the kill races with the natural process group teardown, but the
    // process must terminate quickly.
    expect(["failed", "cancelled"]).toContain(result.status);

    database.connection.close();
  });
});

function persistWorkspaceFixture(database: ArgmaxDatabase): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "argmax-check-")));
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
