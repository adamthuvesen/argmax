// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { ProjectRegistrationError, ProjectService } from "./projectRegistration.js";

describe("ProjectService", () => {
  it("registers a valid git repository with discovered metadata", async () => {
    const repoPath = createGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);

    const project = await service.registerProject({ repoPath });

    expect(project.repoPath).toBe(repoPath);
    expect(project.currentBranch).toBe("main");
    expect(project.defaultBranch).toBe("main");
    expect(project.settings.defaultProvider).toBe("codex");
    expect(project.settings.defaultModelLabel).toBe("GPT-5.3 Codex Spark Low");

    database.connection.close();
  });

  it("rejects directories that are not inside a git repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maestro-not-git-"));
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);

    await expect(service.registerProject({ repoPath: directory })).rejects.toBeInstanceOf(ProjectRegistrationError);

    database.connection.close();
  });

  it("persists project settings updates locally", async () => {
    const repoPath = createGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);
    const project = await service.registerProject({ repoPath });

    const updated = service.updateSettings({
      projectId: project.id,
      settings: {
        defaultProvider: "claude",
        defaultModelLabel: "Claude Haiku",
        worktreeLocation: join(repoPath, ".worktrees"),
        setupCommand: "npm install",
        checkCommands: ["npm run lint", "npm test"]
      }
    });

    expect(updated.settings.defaultProvider).toBe("claude");
    expect(updated.settings.checkCommands).toEqual(["npm run lint", "npm test"]);
    expect(database.listProjects()[0]?.settings.defaultModelLabel).toBe("Claude Haiku");

    database.connection.close();
  });
});

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "maestro-git-"));
  execFileSync("git", ["init", "--initial-branch=main", repoPath]);
  return realpathSync(repoPath);
}
