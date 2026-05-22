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
    expect(project.settings.defaultModelLabel).toBe("Codex Spark");

    database.connection.close();
  });

  it("rejects directories that are not inside a git repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "argmax-not-git-"));
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

  it("prefers main over master and trunk when probing default-branch candidates", async () => {
    const repoPath = createGitRepoWithBranches(["trunk", "master", "main"], "trunk");
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);

    const project = await service.registerProject({ repoPath });

    expect(project.defaultBranch).toBe("main");

    database.connection.close();
  });

  it("falls back to master when main is absent but trunk exists alongside", async () => {
    const repoPath = createGitRepoWithBranches(["trunk", "master"], "trunk");
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);

    const project = await service.registerProject({ repoPath });

    expect(project.defaultBranch).toBe("master");

    database.connection.close();
  });

  it("preserves local settings when re-registering an existing repository", async () => {
    const repoPath = createGitRepo();
    const database = createDatabase(":memory:", { seed: false });
    const service = new ProjectService(database);
    const project = await service.registerProject({ repoPath });

    service.updateSettings({
      projectId: project.id,
      settings: {
        defaultProvider: "claude",
        defaultModelLabel: "Claude Haiku",
        worktreeLocation: join(repoPath, ".custom-worktrees"),
        setupCommand: "uv sync",
        checkCommands: ["uv run pytest", "uv run ruff check"]
      }
    });

    const reRegistered = await service.registerProject({ repoPath });

    expect(reRegistered.id).toBe(project.id);
    expect(reRegistered.settings).toEqual({
      defaultProvider: "claude",
      defaultModelLabel: "Claude Haiku",
      worktreeLocation: join(repoPath, ".custom-worktrees"),
      setupCommand: "uv sync",
      checkCommands: ["uv run pytest", "uv run ruff check"]
    });

    database.connection.close();
  });
});

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "argmax-git-"));
  git(["init", "--initial-branch=main", repoPath]);
  return realpathSync(repoPath);
}

function createGitRepoWithBranches(branches: readonly string[], initialBranch: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), "argmax-git-multi-"));
  git(["init", `--initial-branch=${initialBranch}`, repoPath]);
  git(["-C", repoPath, "config", "user.email", "test@example.com"]);
  git(["-C", repoPath, "config", "user.name", "Test"]);
  git(["-C", repoPath, "commit", "--allow-empty", "-m", "init"]);
  for (const branch of branches) {
    if (branch === initialBranch) continue;
    git(["-C", repoPath, "branch", branch]);
  }
  // Re-checkout initial branch so `branch --show-current` is deterministic.
  git(["-C", repoPath, "checkout", initialBranch]);
  return realpathSync(repoPath);
}

function git(args: string[]): void {
  execFileSync("git", args, { stdio: "pipe" });
}
