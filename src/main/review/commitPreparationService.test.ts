// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../persistence/database.js";
import { CommitPreparationService } from "./commitPreparationService.js";

describe("CommitPreparationService", () => {
  it("prepares selected-file commit commands without mutating git state", () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CommitPreparationService(database);

    const preparation = service.prepareCommit({
      workspaceId,
      selectedFiles: ["src/a.ts", "src/a.ts", "src/b.ts"],
      message: "feat: add review"
    });

    expect(preparation).toEqual({
      workspaceId,
      branch: "maestro/review",
      selectedFiles: ["src/a.ts", "src/b.ts"],
      message: "feat: add review",
      // Display strings are derived from argv arrays; safe characters render
      // unquoted, the commit message is quoted because it contains whitespace
      // and a colon. Execution callers should use `preparePlan` to receive
      // the underlying argv arrays directly and never re-parse this output.
      commands: ["git add -- src/a.ts src/b.ts", "git commit -m 'feat: add review'"]
    });

    database.connection.close();
  });

  it("exposes argv-shaped steps so execution callers can spawn without a shell", () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CommitPreparationService(database);

    const plan = service.preparePlan({
      workspaceId,
      selectedFiles: ["src/has space.ts", "src/-leading-dash.ts"],
      message: "fix: tricky"
    });

    expect(plan.steps).toEqual([
      { argv: ["git", "add", "--", "src/has space.ts", "src/-leading-dash.ts"] },
      { argv: ["git", "commit", "-m", "fix: tricky"] }
    ]);

    database.connection.close();
  });

  it("requires selected files and a commit message", () => {
    const database = createDatabase(":memory:", { seed: false });
    const workspaceId = persistWorkspaceFixture(database);
    const service = new CommitPreparationService(database);

    expect(() => service.prepareCommit({ workspaceId, selectedFiles: [], message: "feat: add review" })).toThrow(
      "Select at least one file"
    );
    expect(() => service.prepareCommit({ workspaceId, selectedFiles: ["src/a.ts"], message: " " })).toThrow(
      "Enter a commit message"
    );

    database.connection.close();
  });
});

function persistWorkspaceFixture(database: MaestroDatabase): string {
  database.persistProject({
    id: "project-1",
    name: "Fixture",
    repoPath: "/repo",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      defaultProvider: "codex",
      defaultModelLabel: "GPT-5.3 Codex Spark Low",
      worktreeLocation: "/repo/.worktrees",
      setupCommand: "",
      checkCommands: []
    }
  });
  const workspace = database.persistWorkspace({
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "Review",
    branch: "maestro/review",
    baseRef: "main",
    path: "/repo/.worktrees/review",
    state: "complete",
    sharedWorkspace: false,
    dirty: true,
    changedFiles: 2
  });

  return workspace.id;
}
